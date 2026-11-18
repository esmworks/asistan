import type { Bot, BotAccess, BotLevel, Role } from '@yumakbot/shared';
import { and, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import { OWNER_ID } from '../users';
import type { SummaryScope, ThreadScope } from './threads';
import { HttpError, notFound } from '../util';

/** Who is asking: a signed-in person, or the access key standing for the owner. */
export interface Viewer {
  userId: string;
  role: Role;
}

const RANK: Record<BotLevel, number> = { none: 0, chat: 1, edit: 2 };

/** Whether a level reaches the one wanted. */
export const atLeast = (level: BotLevel, wanted: BotLevel) => RANK[level] >= RANK[wanted];

/** Whether a role looks after the whole server: its owner and the admins. */
export const managesServer = (role: Role) => role === 'owner' || role === 'admin';

/**
 * What a person may do with a bot: the server's owner and admins and the bot's own owner may
 * change it; anyone else gets the higher of what everyone gets and what they were given.
 */
export function botLevel(viewer: Viewer, bot: { ownerUserId: string; access: BotAccess }): BotLevel {
  if (managesServer(viewer.role) || bot.ownerUserId === viewer.userId) return 'edit';
  const given = bot.access.people[viewer.userId];
  return given && RANK[given] > RANK[bot.access.everyone] ? given : bot.access.everyone;
}

type ThreadRow = typeof schema.threads.$inferSelect;

/** How long the people a conversation's live events go to are remembered. */
const AUDIENCE_MS = 10_000;

/**
 * Who may see and use what: bots by level, conversations by whose they are. A bot a person may
 * not use is answered with "not found", so nobody learns of bots they are not shown.
 */
export class AccessService {
  private audiences = new Map<string, { users: string[]; at: number }>();

  constructor(private ctx: Ctx) {}

  /** Forgets who the live events go to; whenever a bot's sharing or the people change. */
  forget() {
    this.audiences.clear();
  }

  private async bot(botId: string) {
    const [row] = await this.ctx.db
      .select({ id: schema.bots.id, ownerUserId: schema.bots.ownerUserId, access: schema.bots.access })
      .from(schema.bots)
      .where(eq(schema.bots.id, botId))
      .limit(1);
    return row ?? null;
  }

  async level(viewer: Viewer, botId: string): Promise<BotLevel> {
    const bot = await this.bot(botId);
    return bot ? botLevel(viewer, bot) : 'none';
  }

  /** Every bot's level for one person, in one read. */
  async levels(viewer: Viewer): Promise<Map<string, BotLevel>> {
    const rows = await this.ctx.db
      .select({ id: schema.bots.id, ownerUserId: schema.bots.ownerUserId, access: schema.bots.access })
      .from(schema.bots);
    return new Map(rows.map((b) => [b.id, botLevel(viewer, b)]));
  }

  /** The bots a person reaches at least at `wanted`. */
  async botIds(viewer: Viewer, wanted: BotLevel = 'chat'): Promise<string[]> {
    return [...(await this.levels(viewer))].filter(([, l]) => atLeast(l, wanted)).map(([id]) => id);
  }

  /** Refuses a bot a person may not use as asked: unseen ones as not found, the rest as forbidden. */
  async requireBot(viewer: Viewer, botId: string, wanted: BotLevel): Promise<BotLevel> {
    const level = await this.level(viewer, botId);
    if (level === 'none') throw notFound('bot');
    if (!atLeast(level, wanted)) throw new HttpError(403, 'error.botEditOnly');
    return level;
  }

  /**
   * Whether a person sees a conversation: their own, or the bot's own work when they may change
   * the bot. Nobody sees another person's conversations, the server's owner and admins included.
   */
  async seesThread(viewer: Viewer, row: Pick<ThreadRow, 'userId' | 'botId'>): Promise<boolean> {
    if (row.userId) return row.userId === viewer.userId;
    return atLeast(await this.level(viewer, row.botId), 'edit');
  }

  /**
   * A conversation a person may see, or not found. To write in it they must still be able to talk
   * with its bot (in a room, with every bot in it): a bot no longer shared with them keeps their
   * conversations readable, not writable.
   */
  async requireThread(viewer: Viewer, threadId: string, write: boolean): Promise<ThreadRow> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.threads)
      .where(eq(schema.threads.id, threadId))
      .limit(1);
    if (!row || !(await this.seesThread(viewer, row))) throw notFound('thread');
    if (write) {
      const botIds =
        row.kind === 'room'
          ? (
              await this.ctx.db
                .select({ botId: schema.roomMembers.botId })
                .from(schema.roomMembers)
                .where(eq(schema.roomMembers.roomId, row.id))
            ).map((m) => m.botId)
          : [row.botId];
      for (const botId of botIds) {
        if (!atLeast(await this.level(viewer, botId), 'chat')) throw new HttpError(403, 'error.botNotShared');
      }
    }
    return row;
  }

  /** A person as a viewer; someone no longer here counts as a member, reaching only what is shared with everyone. */
  async viewerOf(userId: string): Promise<Viewer> {
    const [row] = await this.ctx.db
      .select({ role: schema.users.role, disabledAt: schema.users.disabledAt })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    return { userId, role: row && !row.disabledAt ? row.role : 'member' };
  }

  /**
   * A bot one bot reaches for a person while it works: the bot itself, or another the person
   * reaches at least at `wanted`. A bot works for someone, so it reaches no further than they do.
   */
  async reach(person: string, from: { id: string }, target: Bot, wanted: BotLevel): Promise<Bot> {
    if (target.id === from.id) return target;
    if (!atLeast(await this.level(await this.viewerOf(person), target.id), wanted)) throw notFound('bot');
    return target;
  }

  /** The person who owns a bot; the server's owner when the bot is gone. */
  async botOwner(botId: string): Promise<string> {
    return (await this.bot(botId))?.ownerUserId ?? OWNER_ID;
  }

  /**
   * The person a conversation stands for: whose it is, or for the bot's own work, the bot's owner.
   * What the bot hands over from such work goes to them.
   */
  async personOf(row: { userId?: string | null; botId: string }): Promise<string> {
    return row.userId ?? (await this.botOwner(row.botId));
  }

  /** What a bot reads of its other conversations while it works in one: that person's, and its own work. */
  seenFrom(person: string): SQL {
    return or(eq(schema.threads.userId, person), isNull(schema.threads.userId))!;
  }

  private async people(): Promise<Viewer[]> {
    return this.ctx.db
      .select({ userId: schema.users.id, role: schema.users.role })
      .from(schema.users)
      .where(isNull(schema.users.disabledAt));
  }

  /** Which of a bot's conversations a person's list holds. */
  async listScope(viewer: Viewer, botId: string): Promise<ThreadScope> {
    return { userId: viewer.userId, botWork: atLeast(await this.level(viewer, botId), 'edit') };
  }

  /** One person's sidebar: the bots they reach and the conversations they see. */
  async summaryScope(viewer: Viewer): Promise<SummaryScope> {
    const levels = [...(await this.levels(viewer))];
    const editable = levels.filter(([, l]) => atLeast(l, 'edit')).map(([id]) => id);
    return {
      botIds: levels.filter(([, l]) => atLeast(l, 'chat')).map(([id]) => id),
      editable,
      seen: this.threadsSeenBy(viewer, editable),
    };
  }

  /** The people who reach a bot at least at `wanted`; remembered a few seconds, like audiences. */
  async botPeople(botId: string, wanted: BotLevel): Promise<string[]> {
    const key = `bot:${botId}:${wanted}`;
    const now = Date.now();
    const kept = this.audiences.get(key);
    if (kept && now - kept.at < AUDIENCE_MS) return kept.users;
    const bot = await this.bot(botId);
    const users = bot
      ? (await this.people()).filter((p) => atLeast(botLevel(p, bot), wanted)).map((p) => p.userId)
      : [];
    this.audiences.set(key, { users, at: now });
    return users;
  }

  /** The people a conversation's live events go to: its person, or those who may change its bot. */
  async threadAudience(threadId: string): Promise<string[]> {
    const now = Date.now();
    const kept = this.audiences.get(`thread:${threadId}`);
    if (kept && now - kept.at < AUDIENCE_MS) return kept.users;
    const [row] = await this.ctx.db
      .select({ userId: schema.threads.userId, botId: schema.threads.botId })
      .from(schema.threads)
      .where(eq(schema.threads.id, threadId))
      .limit(1);
    const users = !row ? [] : row.userId ? [row.userId] : await this.botPeople(row.botId, 'edit');
    this.audiences.set(`thread:${threadId}`, { users, at: now });
    return users;
  }

  /** The conversations of one bot a person sees, by id, among `threadIds`. */
  async visibleThreads(viewer: Viewer, threadIds: string[]): Promise<Set<string>> {
    if (!threadIds.length) return new Set();
    const rows = await this.ctx.db
      .select({ id: schema.threads.id, userId: schema.threads.userId, botId: schema.threads.botId })
      .from(schema.threads)
      .where(inArray(schema.threads.id, threadIds));
    const editable = new Set(await this.botIds(viewer, 'edit'));
    return new Set(
      rows.filter((r) => (r.userId ? r.userId === viewer.userId : editable.has(r.botId))).map((r) => r.id),
    );
  }

  /** The SQL condition for the conversations a person sees, given the bots they may change. */
  threadsSeenBy(viewer: Viewer, editableBotIds: string[]): SQL {
    const own = eq(schema.threads.userId, viewer.userId);
    if (!editableBotIds.length) return own;
    return or(own, and(isNull(schema.threads.userId), inArray(schema.threads.botId, editableBotIds)))!;
  }
}
