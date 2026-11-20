import { outsideIn } from '@leafbot/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { Ctx } from '../context';
import type { GateRequest } from '../engine/types';
import { schema } from '../db';
import { truncate } from '../util';

type TurnRow = typeof schema.turns.$inferSelect;

/** How many of the person's latest messages count, and how much of each. */
const RECENT = 3;
const EACH = 2000;
/** A bot handing work to a bot handing work on: how far back the person's request is looked for. */
const MAX_HOPS = 6;

/**
 * What the person themselves asked for: only their own words, never text that came from outside.
 * A page address that imitates a site they use is told apart from one they named by these words. A turn's prompt is not that: a webhook
 * routine's prompt carries the caller's payload, a bot-to-bot turn's is another bot's message, and
 * a person's message can carry a quoted bot reply or attached files.
 *
 * - The person's message (or emoji): their latest messages in that conversation, as saved.
 * - A routine: the instructions saved on the routine, without the payload or the last report.
 * - Work another bot handed over: the words behind the turn that handed it over, followed back.
 *
 * Empty when there are none (a bot's message in a room nobody wrote in, a deleted routine): then
 * nothing the person said covers the action.
 */
export async function ownerWords(ctx: Ctx, turn: TurnRow, hops = 0): Promise<string[]> {
  if (turn.source === 'user' || turn.source === 'reaction') return personWords(ctx, turn);
  if (turn.source === 'routine') {
    if (!turn.routineRunId) return [];
    const [row] = await ctx.db
      .select({ prompt: schema.routines.prompt })
      .from(schema.routineRuns)
      .innerJoin(schema.routines, eq(schema.routines.id, schema.routineRuns.routineId))
      .where(eq(schema.routineRuns.id, turn.routineRunId))
      .limit(1);
    return row ? [truncate(row.prompt, EACH * RECENT)] : [];
  }
  // A bot's turn: the request the work started from, if a person's.
  if (turn.jobId && hops < MAX_HOPS) {
    const [job] = await ctx.db
      .select({ fromTurnId: schema.jobs.fromTurnId })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, turn.jobId))
      .limit(1);
    if (!job?.fromTurnId) return [];
    const [from] = await ctx.db
      .select()
      .from(schema.turns)
      .where(eq(schema.turns.id, job.fromTurnId))
      .limit(1);
    return from ? ownerWords(ctx, from, hops + 1) : [];
  }
  // A bot speaking up in a room answers what the person last wrote there.
  const [thread] = await ctx.db
    .select({ kind: schema.threads.kind })
    .from(schema.threads)
    .where(eq(schema.threads.id, turn.threadId))
    .limit(1);
  return thread?.kind === 'room' ? personWords(ctx, turn) : [];
}

/** Outside text that starts a routine's run, as against what the run reads on its way. */
const STARTS_RUN: ReadonlySet<string> = new Set<GateRequest['trigger']>([
  'watch',
  'webhook',
  'email',
  'whatsapp',
]);

/**
 * Who asked for the work a turn does, followed back through work bots handed on:
 * - `message`: a message the person wrote (or their emoji);
 * - `routine`: a routine the person saved, run on its schedule or by hand, whose instructions are
 *   their words; a run a mail, a webhook, a watched page or a WhatsApp group started is not;
 * - null: nobody just now (a room's round, a run outside text started, a chain whose start is gone).
 */
export async function requestedBy(ctx: Ctx, turn: TurnRow, hops = 0): Promise<'message' | 'routine' | null> {
  if (turn.source === 'user' || turn.source === 'reaction') return 'message';
  if (turn.source === 'routine') {
    if (!turn.routineRunId) return null;
    const [run] = await ctx.db
      .select({ trigger: schema.routineRuns.trigger })
      .from(schema.routineRuns)
      .where(eq(schema.routineRuns.id, turn.routineRunId))
      .limit(1);
    return run && !(run.trigger && STARTS_RUN.has(run.trigger)) ? 'routine' : null;
  }
  if (!turn.jobId || hops >= MAX_HOPS) return null;
  const [job] = await ctx.db
    .select({ fromTurnId: schema.jobs.fromTurnId })
    .from(schema.jobs)
    .where(eq(schema.jobs.id, turn.jobId))
    .limit(1);
  if (!job?.fromTurnId) return null;
  const [from] = await ctx.db.select().from(schema.turns).where(eq(schema.turns.id, job.fromTurnId)).limit(1);
  return from ? requestedBy(ctx, from, hops + 1) : null;
}

/**
 * The person's latest messages in the turn's conversation, oldest first; messages written while
 * the turn runs are handed to it too, so they count. A message they forwarded from someone else
 * is that one's words, and does not.
 */
async function personWords(ctx: Ctx, turn: TurnRow): Promise<string[]> {
  const rows = await ctx.db
    .select({ text: schema.messages.text, props: schema.messages.props })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.threadId, turn.threadId),
        eq(schema.messages.role, 'user'),
        eq(schema.messages.author, 'user'),
      ),
    )
    .orderBy(desc(schema.messages.createdAt))
    .limit(RECENT);
  return rows
    .filter((r) => !outsideIn(r.props as Record<string, unknown>))
    .map((r) => r.text.trim())
    .filter(Boolean)
    .reverse()
    .map((text) => truncate(text, EACH));
}
