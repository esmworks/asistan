import { and, asc, eq } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import { HttpError } from '../util';
import type { Services } from '.';
import { OWNER_ID } from '../users';

/** What a call to a bot gives back: its reply, or how far the turn got by the time the wait ran out. */
export interface AskResult {
  status: 'done' | 'error' | 'interrupted' | 'running';
  reply: string;
  error: string | null;
  threadId: string;
  turnId: string;
}

/** The owner's keeps the key it had before people came in; everyone else has their own. */
const API_THREAD = (botId: string, userId: string) =>
  userId === OWNER_ID ? `api-thread:${botId}` : `api-thread:${botId}:${userId}`;

/**
 * A bot as an API: a message sent from a script or another app, answered in a conversation of its
 * own ("API") so the person's chat stays as it was, and the reply returned when the turn ends.
 */
export class BotApi {
  constructor(
    private ctx: Ctx,
    private services: Services,
  ) {}

  /** The bot's API conversation, made the first time and again if it was deleted. */
  private async thread(botId: string, userId: string): Promise<string> {
    const key = API_THREAD(botId, userId);
    const [kept] = await this.ctx.db.select().from(schema.kv).where(eq(schema.kv.key, key)).limit(1);
    const id = typeof kept?.value === 'string' ? kept.value : null;
    if (id) {
      const row = await this.services.threads.row(id).catch(() => null);
      if (row && row.botId === botId && row.userId === userId) return id;
    }
    const created = await this.services.threads.create(botId, { title: 'API', kind: 'api', userId });
    await this.ctx.db
      .insert(schema.kv)
      .values({ key, value: created.id })
      .onConflictDoUpdate({ target: schema.kv.key, set: { value: created.id } });
    return created.id;
  }

  async ask(
    botId: string,
    text: string,
    opts: { threadId?: string; waitMs: number; userId?: string | null },
  ): Promise<AskResult> {
    const bot = await this.services.bots.get(botId);
    if (bot.archivedAt) throw new HttpError(409, 'error.botArchived');
    const person = opts.userId ?? OWNER_ID;
    let threadId = opts.threadId;
    if (threadId) {
      // Only the person's own conversation with this bot.
      const row = await this.services.threads.row(threadId);
      if (row.botId !== botId || row.userId !== person) throw new HttpError(404, 'error.notFound');
    } else {
      threadId = await this.thread(botId, person);
    }
    const { message } = await this.services.threads.addMessage({
      threadId,
      role: 'user',
      author: 'user',
      userId: opts.userId ?? null,
      text,
      props: { viaApi: true },
    });
    const turn = await this.services.turns.enqueue({
      threadId,
      botId,
      source: 'user',
      prompt: text,
      userId: opts.userId ?? null,
    });
    await this.services.threads.updateMessage(message.id, { turnId: turn.id });
    return this.result(turn.id, opts.waitMs);
  }

  /** The turn's outcome, waiting up to `waitMs` for it to end. */
  async result(turnId: string, waitMs = 0): Promise<AskResult> {
    const until = Date.now() + waitMs;
    for (;;) {
      const [turn] = await this.ctx.db
        .select()
        .from(schema.turns)
        .where(eq(schema.turns.id, turnId))
        .limit(1);
      if (!turn) throw new HttpError(404, 'error.notFound');
      const ended = turn.status === 'done' || turn.status === 'error' || turn.status === 'interrupted';
      if (ended || Date.now() >= until) {
        const replies = await this.ctx.db
          .select({ text: schema.messages.text })
          .from(schema.messages)
          .where(and(eq(schema.messages.turnId, turnId), eq(schema.messages.role, 'assistant')))
          .orderBy(asc(schema.messages.createdAt));
        return {
          status: ended ? (turn.status as AskResult['status']) : 'running',
          reply: replies
            .map((r) => r.text)
            .join('\n\n')
            .trim(),
          error: turn.error,
          threadId: turn.threadId,
          turnId,
        };
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}
