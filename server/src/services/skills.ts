import type { Skill, SkillChange, SkillCreate, SkillUpdate } from '@yumakbot/shared';
import { asc, and, eq, isNull, sql } from 'drizzle-orm';
import { canAdminister } from '../auth';
import type { Ctx } from '../context';
import { schema } from '../db';
import { HttpError, isUniqueViolation, newId, notFound } from '../util';

type Row = typeof schema.skills.$inferSelect;

const toSkill = (r: Row, botIds: string[]): Skill => ({
  id: r.id,
  name: r.name,
  description: r.description,
  body: r.body,
  botIds,
  uses: r.uses,
  lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

/** Who decides on a skill: the person, and whether they look after the server. */
export interface SkillReach {
  userId: string;
  admin: boolean;
}

/** A skill is changed by whoever made it, and by the admins (alone, for one nobody owns now). */
const decides = (reach: SkillReach, createdBy: string | null) => reach.admin || createdBy === reach.userId;

/**
 * Skills: written instructions for a kind of task, kept once and turned on per bot. A bot sees
 * the name and description of each skill it has, and reads the rest when a task calls for it.
 */
export class SkillService {
  constructor(private ctx: Ctx) {}

  async list(): Promise<Skill[]> {
    const rows = await this.ctx.db.select().from(schema.skills).orderBy(asc(schema.skills.name));
    const links = await this.ctx.db.select().from(schema.botSkills);
    return rows.map((r) =>
      toSkill(
        r,
        links.filter((l) => l.skillId === r.id).map((l) => l.botId),
      ),
    );
  }

  async get(id: string): Promise<Skill> {
    const skill = (await this.list()).find((s) => s.id === id);
    if (!skill) throw notFound('skill');
    return skill;
  }

  /** The skills a bot has on, by name. */
  async forBot(botId: string): Promise<Skill[]> {
    return (await this.list()).filter((s) => s.botIds.includes(botId));
  }

  async create(input: SkillCreate, userId: string | null = null): Promise<Skill> {
    const id = newId();
    try {
      await this.ctx.db.insert(schema.skills).values({
        id,
        name: input.name,
        description: input.description,
        body: input.body ?? '',
        createdByUserId: userId,
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'error.skillExists', { name: input.name });
      throw err;
    }
    for (const botId of input.botIds ?? []) await this.setBot(id, botId, true, false);
    this.changed();
    return this.get(id);
  }

  async update(id: string, patch: SkillUpdate): Promise<Skill> {
    await this.get(id);
    try {
      await this.ctx.db
        .update(schema.skills)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(schema.skills.id, id));
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'error.skillExists', { name: patch.name ?? '' });
      throw err;
    }
    this.changed();
    return this.get(id);
  }

  async remove(id: string) {
    await this.get(id);
    await this.ctx.db.delete(schema.skills).where(eq(schema.skills.id, id));
    this.changed();
  }

  async setBot(skillId: string, botId: string, on: boolean, notify = true): Promise<void> {
    const [bot] = await this.ctx.db
      .select({ id: schema.bots.id })
      .from(schema.bots)
      .where(eq(schema.bots.id, botId))
      .limit(1);
    if (!bot) throw notFound('bot');
    if (on) {
      await this.ctx.db.insert(schema.botSkills).values({ botId, skillId }).onConflictDoNothing();
    } else {
      await this.ctx.db
        .delete(schema.botSkills)
        .where(and(eq(schema.botSkills.botId, botId), eq(schema.botSkills.skillId, skillId)));
    }
    if (notify) this.changed();
  }

  /** Who decides on skills, for a person by id. */
  async reachOf(userId: string): Promise<SkillReach> {
    const [row] = await this.ctx.db
      .select({ role: schema.users.role })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    return { userId, admin: !!row && canAdminister(row.role) };
  }

  /** Whether the person may change the skill straight away. */
  async mayChange(id: string, reach: SkillReach): Promise<boolean> {
    const [row] = await this.ctx.db
      .select({ by: schema.skills.createdByUserId })
      .from(schema.skills)
      .where(eq(schema.skills.id, id))
      .limit(1);
    if (!row) throw notFound('skill');
    return decides(reach, row.by);
  }

  /** Counts a bot reading the skill for a task. */
  async markUsed(id: string): Promise<void> {
    await this.ctx.db
      .update(schema.skills)
      .set({ uses: sql`${schema.skills.uses} + 1`, lastUsedAt: new Date() })
      .where(eq(schema.skills.id, id));
  }

  /**
   * Keeps a bot's change to a skill for the skill's owner to read. A newer change from the same
   * bot for the same person takes the place of the one still waiting, so the owner reads the
   * bot's latest version once.
   */
  async propose(input: {
    skillId: string;
    description: string;
    body: string;
    reason: string | null;
    proposedBy: string;
    userId: string | null;
    threadId: string | null;
  }): Promise<void> {
    await this.ctx.db.transaction(async (tx) => {
      await tx
        .delete(schema.skillChanges)
        .where(
          and(
            eq(schema.skillChanges.skillId, input.skillId),
            eq(schema.skillChanges.proposedBy, input.proposedBy),
            input.userId ? eq(schema.skillChanges.userId, input.userId) : isNull(schema.skillChanges.userId),
          ),
        );
      await tx.insert(schema.skillChanges).values({ id: newId(), ...input });
    });
    this.changed();
  }

  /** The changes waiting, oldest first; with `reach`, those that person decides on. */
  async changes(reach?: SkillReach): Promise<SkillChange[]> {
    const rows = await this.ctx.db
      .select({
        change: schema.skillChanges,
        skillName: schema.skills.name,
        createdBy: schema.skills.createdByUserId,
        userName: schema.users.displayName,
        username: schema.users.username,
      })
      .from(schema.skillChanges)
      .innerJoin(schema.skills, eq(schema.skills.id, schema.skillChanges.skillId))
      .leftJoin(schema.users, eq(schema.users.id, schema.skillChanges.userId))
      .orderBy(asc(schema.skillChanges.createdAt));
    return rows
      .filter((r) => !reach || decides(reach, r.createdBy))
      .map(({ change: c, skillName, userName, username }) => ({
        id: c.id,
        skillId: c.skillId,
        skillName,
        description: c.description,
        body: c.body,
        reason: c.reason,
        proposedBy: c.proposedBy,
        userId: c.userId,
        userName: userName || username || null,
        threadId: c.threadId,
        createdAt: c.createdAt.toISOString(),
      }));
  }

  /** Makes a waiting change, for someone who decides on its skill. */
  async acceptChange(id: string, reach: SkillReach): Promise<Skill> {
    const change = await this.waiting(id, reach);
    const skill = await this.update(change.skillId, { description: change.description, body: change.body });
    await this.ctx.db.delete(schema.skillChanges).where(eq(schema.skillChanges.id, id));
    this.changed();
    return skill;
  }

  async rejectChange(id: string, reach: SkillReach): Promise<void> {
    await this.waiting(id, reach);
    await this.ctx.db.delete(schema.skillChanges).where(eq(schema.skillChanges.id, id));
    this.changed();
  }

  /** A waiting change; one the person does not decide on is not theirs to see. */
  private async waiting(id: string, reach: SkillReach): Promise<SkillChange> {
    const change = (await this.changes(reach)).find((c) => c.id === id);
    if (!change) throw notFound('skill');
    return change;
  }

  private changed() {
    this.ctx.bus.refresh({ scope: 'skills' });
  }
}
