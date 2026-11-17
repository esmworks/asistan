import type { BotAction, BotActionHow } from '@yumakbot/shared';
import { asc, desc, eq, lt } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import { newId, truncate } from '../util';
import { csvCell } from './usage';

/** How long a step that changed something is kept in a bot's list. */
export const ACTION_KEEP_DAYS = 90;

/** The most steps one list shows. */
const LIST_MAX = 500;

const toAction = (r: typeof schema.botActions.$inferSelect): BotAction => ({
  id: r.id,
  botId: r.botId,
  threadId: r.threadId,
  toolName: r.toolName,
  summary: r.summary,
  how: r.how,
  rule: r.rule,
  outside: r.outside,
  createdAt: r.createdAt.toISOString(),
});

/**
 * The steps each bot was let take, and what let each one: a line for every step that is not a
 * read, kept when it is let through, so the person can look back at what a bot did on its own, by
 * a rule, or after their own answer. Whether the step then succeeded is in its conversation.
 */
export class ActionService {
  constructor(private ctx: Ctx) {}

  async record(a: {
    botId: string;
    threadId: string | null;
    turnId: string | null;
    toolName: string;
    summary: string;
    how: BotActionHow;
    rule?: string | null;
    approvalId?: string | null;
    outside?: boolean;
  }): Promise<void> {
    await this.ctx.db.insert(schema.botActions).values({
      id: newId(),
      botId: a.botId,
      threadId: a.threadId,
      turnId: a.turnId,
      toolName: a.toolName,
      summary: truncate(a.summary, 500),
      how: a.how,
      rule: a.rule ?? null,
      approvalId: a.approvalId ?? null,
      outside: !!a.outside,
    });
    this.ctx.bus.refresh({ scope: 'actions', botId: a.botId });
  }

  /** A bot's steps, newest first. */
  async list(botId: string, limit = 100): Promise<BotAction[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.botActions)
      .where(eq(schema.botActions.botId, botId))
      .orderBy(desc(schema.botActions.createdAt))
      .limit(Math.max(1, Math.min(limit, LIST_MAX)));
    return rows.map(toAction);
  }

  /** A bot's steps as a spreadsheet, oldest first: every step still kept. */
  async csv(botId: string): Promise<string> {
    const rows = await this.ctx.db
      .select()
      .from(schema.botActions)
      .where(eq(schema.botActions.botId, botId))
      .orderBy(asc(schema.botActions.createdAt));
    const lines = [['at', 'step', 'tool', 'let_through_by', 'rule', 'outside_text'].join(',')];
    for (const r of rows) {
      lines.push(
        [r.createdAt.toISOString(), r.summary, r.toolName, r.how, r.rule, r.outside ? 'yes' : 'no']
          .map((v) => csvCell(v ?? null))
          .join(','),
      );
    }
    return `${lines.join('\n')}\n`;
  }

  /** Lets go of steps older than `ACTION_KEEP_DAYS`. */
  async prune(now = new Date()): Promise<void> {
    const before = new Date(now.getTime() - ACTION_KEEP_DAYS * 86_400_000);
    await this.ctx.db.delete(schema.botActions).where(lt(schema.botActions.createdAt, before));
  }
}
