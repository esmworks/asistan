import { homedir } from 'node:os';
import {
  leavesForEngine,
  type Bot,
  type BotCreate,
  type BotEngineChoice,
  type BotMove,
  type BotUpdate,
  type Group,
  type GroupMove,
} from '@yumakbot/shared';
import { asc, eq, isNull, max } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import { HttpError, newId, notFound } from '../util';
import { projectDirProblem } from '../workspace';
import { toBot, toGroup } from './mappers';

type Tx = Parameters<Parameters<Ctx['db']['transaction']>[0]>[0];

export class BotService {
  constructor(private ctx: Ctx) {}

  async list(opts: { includeArchived?: boolean } = {}): Promise<Bot[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.bots)
      .where(opts.includeArchived ? undefined : isNull(schema.bots.archivedAt))
      .orderBy(asc(schema.bots.position), asc(schema.bots.createdAt));
    return rows.map(toBot);
  }

  async get(id: string): Promise<Bot> {
    const [row] = await this.ctx.db.select().from(schema.bots).where(eq(schema.bots.id, id)).limit(1);
    if (!row) throw notFound('bot');
    return toBot(row);
  }

  /** Find by id or (case-insensitive) name, for tools where the model names a bot. */
  /**
   * A bot by id or name. When several bots share the name, the one in the same sidebar group as
   * `near` (the bot asking) wins, since that is the one its person most likely means.
   */
  async resolve(ref: string, near?: Pick<Bot, 'id' | 'groupId'>): Promise<Bot> {
    const bots = await this.list();
    const byId = bots.find((b) => b.id === ref);
    if (byId) return byId;
    const lower = ref.trim().toLowerCase();
    const named = bots.filter((b) => b.name.toLowerCase() === lower && b.id !== near?.id);
    const bot =
      (near && named.find((b) => b.groupId === near.groupId)) ??
      named[0] ??
      bots.find((b) => b.name.toLowerCase() === lower);
    if (!bot) throw new HttpError(404, 'error.noBotNamed', { ref });
    return bot;
  }

  /** Refuses a project folder that would hand the bot far more than a project. */
  private checkProjectDir(dir: string | null | undefined) {
    if (!dir) return;
    const problem = projectDirProblem(dir, { home: homedir(), dataDir: this.ctx.config.dataDir });
    if (problem) throw new HttpError(400, problem);
  }

  async create(input: BotCreate): Promise<Bot> {
    if (input.groupId) await this.getGroup(input.groupId);
    this.checkProjectDir(input.projectDir);
    const [last] = await this.ctx.db.select({ n: max(schema.bots.position) }).from(schema.bots);
    // A new bot goes to the end of its section; managers start out pinned.
    const [row] = await this.ctx.db
      .insert(schema.bots)
      .values({ id: newId(), ...input, pinned: input.isManager, position: (last?.n ?? -1) + 1 })
      .returning();
    this.ctx.bus.refresh({ scope: 'bots' });
    return toBot(row!);
  }

  async update(id: string, patch: BotUpdate): Promise<Bot> {
    const before = await this.get(id);
    if (patch.groupId) await this.getGroup(patch.groupId);
    if (patch.projectDir !== undefined && patch.projectDir !== before.projectDir)
      this.checkProjectDir(patch.projectDir);
    const leaves = !!patch.engine && patch.engine !== before.engine;
    const row = await this.ctx.db.transaction(async (tx) => {
      if (leaves) await this.leaveEngine(tx, id);
      const [saved] = await tx
        .update(schema.bots)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(schema.bots.id, id))
        .returning();
      return saved;
    });
    this.ctx.bus.refresh({ scope: 'bots' });
    if (leaves) this.ctx.bus.refresh({ scope: 'routines' });
    return toBot(row!);
  }

  /**
   * Moves every active bot to `target`, what new bots start with, in one write; returns how
   * many changed. Archived bots stay as they are.
   */
  async moveAllTo(target: BotEngineChoice): Promise<number> {
    const moving = (await this.list()).filter((b) => leavesForEngine(b, target));
    if (!moving.length) return 0;
    await this.ctx.db.transaction(async (tx) => {
      for (const bot of moving) {
        if (bot.engine !== target.engine) await this.leaveEngine(tx, bot.id);
        // Only bots on another provider move to Claude, so none of them keeps a model there.
        await tx
          .update(schema.bots)
          .set({ engine: target.engine, model: target.model, updatedAt: new Date() })
          .where(eq(schema.bots.id, bot.id));
      }
    });
    this.ctx.bus.refresh({ scope: 'bots' });
    this.ctx.bus.refresh({ scope: 'routines' });
    return moving.length;
  }

  /** What a bot leaves behind when it moves to the other engine. */
  private async leaveEngine(tx: Tx, botId: string) {
    // A session belongs to the engine that made it; the other engine cannot resume it, so the
    // next turn starts a new one with the recent exchange. A room member keeps its own session.
    await tx
      .update(schema.threads)
      .set({ engineSessionId: null, engineSessionCostUsd: null })
      .where(eq(schema.threads.botId, botId));
    await tx
      .update(schema.roomMembers)
      .set({ engineSessionId: null, engineSessionCostUsd: null })
      .where(eq(schema.roomMembers.botId, botId));
    // A routine's own model names one of the old engine's models; its runs take the bot's model.
    await tx.update(schema.routines).set({ model: '' }).where(eq(schema.routines.botId, botId));
  }

  /** Moves a bot to another place in the sidebar and renumbers the section it lands in. */
  async move(id: string, to: BotMove): Promise<Bot> {
    const bot = await this.get(id);
    if (!to.pinned && to.groupId) await this.getGroup(to.groupId);
    const groupId = to.pinned ? bot.groupId : to.groupId;
    const section = (await this.list()).filter(
      (b) => b.id !== id && b.pinned === to.pinned && (to.pinned || b.groupId === groupId),
    );
    const at = to.beforeId ? section.findIndex((b) => b.id === to.beforeId) : -1;
    const ordered = section.map((b) => b.id);
    ordered.splice(at < 0 ? ordered.length : at, 0, id);
    await this.ctx.db.transaction(async (tx) => {
      for (const [position, botId] of ordered.entries()) {
        const fields = botId === id ? { position, pinned: to.pinned, groupId } : { position };
        await tx.update(schema.bots).set(fields).where(eq(schema.bots.id, botId));
      }
    });
    this.ctx.bus.refresh({ scope: 'bots' });
    return this.get(id);
  }

  async archive(id: string): Promise<Bot> {
    await this.get(id);
    const [row] = await this.ctx.db
      .update(schema.bots)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.bots.id, id))
      .returning();
    this.ctx.bus.refresh({ scope: 'bots' });
    return toBot(row!);
  }

  async restore(id: string): Promise<Bot> {
    const [row] = await this.ctx.db
      .update(schema.bots)
      .set({ archivedAt: null, updatedAt: new Date() })
      .where(eq(schema.bots.id, id))
      .returning();
    if (!row) throw notFound('bot');
    this.ctx.bus.refresh({ scope: 'bots' });
    return toBot(row);
  }

  /**
   * Removes an archived bot for good, with its conversations, memory and routines. Only an
   * archived bot can go, so a bot is never lost to one wrong click.
   */
  async purge(id: string): Promise<void> {
    const bot = await this.get(id);
    if (!bot.archivedAt) throw new HttpError(409, 'error.botNotArchived');
    await this.ctx.db.delete(schema.bots).where(eq(schema.bots.id, id));
    this.ctx.bus.refresh({ scope: 'bots' });
  }

  /** Who may message whom: any bot any other active bot. Groups only share a folder. */
  canMessage(from: Bot, to: Bot): boolean {
    return from.id !== to.id && !to.archivedAt;
  }

  async listGroups(): Promise<Group[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.groups)
      .orderBy(asc(schema.groups.position), asc(schema.groups.createdAt));
    return rows.map(toGroup);
  }

  async getGroup(id: string): Promise<Group> {
    const [row] = await this.ctx.db.select().from(schema.groups).where(eq(schema.groups.id, id)).limit(1);
    if (!row) throw notFound('group');
    return toGroup(row);
  }

  async createGroup(name: string): Promise<Group> {
    const [last] = await this.ctx.db.select({ n: max(schema.groups.position) }).from(schema.groups);
    const [row] = await this.ctx.db
      .insert(schema.groups)
      .values({ id: newId(), name, position: (last?.n ?? -1) + 1 })
      .returning();
    this.ctx.bus.refresh({ scope: 'groups' });
    return toGroup(row!);
  }

  async renameGroup(id: string, name: string): Promise<Group> {
    const [row] = await this.ctx.db
      .update(schema.groups)
      .set({ name })
      .where(eq(schema.groups.id, id))
      .returning();
    if (!row) throw notFound('group');
    this.ctx.bus.refresh({ scope: 'groups' });
    return toGroup(row);
  }

  /** Moves a group to another place in the sidebar and renumbers the groups. */
  async moveGroup(id: string, to: GroupMove): Promise<Group> {
    const group = await this.getGroup(id);
    const ordered = (await this.listGroups()).filter((g) => g.id !== id).map((g) => g.id);
    const at = to.beforeId ? ordered.indexOf(to.beforeId) : -1;
    ordered.splice(at < 0 ? ordered.length : at, 0, id);
    await this.ctx.db.transaction(async (tx) => {
      for (const [position, groupId] of ordered.entries()) {
        await tx.update(schema.groups).set({ position }).where(eq(schema.groups.id, groupId));
      }
    });
    this.ctx.bus.refresh({ scope: 'groups' });
    return group;
  }

  /**
   * Deletes a group. Its bots stay where they are on the pinned row, or go to the end of the
   * ungrouped bots; they lose the group's shared folder, which is left on disk.
   */
  async deleteGroup(id: string) {
    await this.getGroup(id);
    const bots = await this.list();
    const members = bots.filter((b) => b.groupId === id && !b.pinned);
    const ungrouped = bots.filter((b) => !b.pinned && !b.groupId);
    await this.ctx.db.transaction(async (tx) => {
      for (const [i, bot] of members.entries()) {
        await tx
          .update(schema.bots)
          .set({ position: ungrouped.length + i })
          .where(eq(schema.bots.id, bot.id));
      }
      // Archived and pinned bots let go of the group too.
      await tx.update(schema.bots).set({ groupId: null }).where(eq(schema.bots.groupId, id));
      await tx.delete(schema.groups).where(eq(schema.groups.id, id));
    });
    this.ctx.bus.refresh({ scope: 'bots' });
    this.ctx.bus.refresh({ scope: 'groups' });
  }
}
