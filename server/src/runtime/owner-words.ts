import { and, desc, eq } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import { truncate } from '../util';

type TurnRow = typeof schema.turns.$inferSelect;

/** How many of the person's latest messages count, and how much of each. */
const RECENT = 3;
const EACH = 2000;
/** A bot handing work to a bot handing work on: how far back the person's request is looked for. */
const MAX_HOPS = 6;

/**
 * What the person themselves asked for, as the reviewer of a permission request may read it: only
 * their own words, never text that came from outside. A turn's prompt is not that: a webhook
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

/**
 * The person's latest messages in the turn's conversation, oldest first; messages written while
 * the turn runs are handed to it too, so they count.
 */
async function personWords(ctx: Ctx, turn: TurnRow): Promise<string[]> {
  const rows = await ctx.db
    .select({ text: schema.messages.text })
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
    .map((r) => r.text.trim())
    .filter(Boolean)
    .reverse()
    .map((text) => truncate(text, EACH));
}

/** Text compared loosely: case, spacing and quote marks do not matter. */
const loose = (s: string) =>
  s
    .toLocaleLowerCase('tr')
    .replace(/[“”«»"'‘’`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Whether the reviewer's quote is really in the person's words. A reviewer that lets an action run
 * must point at what was said; a quote that is not there, or too short to mean anything, does not
 * count, whatever the reviewer was persuaded of.
 */
export function quoteFound(quote: string, words: readonly string[]): boolean {
  const q = loose(quote);
  if (q.length < 3) return false;
  return words.some((w) => loose(w).includes(q));
}
