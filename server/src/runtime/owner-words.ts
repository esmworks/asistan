import { outsideIn, parseAnswers, questionItems } from '@yumakbot/shared';
import { and, desc, eq, gte } from 'drizzle-orm';
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

/** Outside text that starts a routine's run, as against what the run reads on its way. */
const STARTS_RUN: ReadonlySet<string> = new Set<GateRequest['trigger']>(['watch', 'webhook', 'email']);

/**
 * Who asked for the work a turn does, followed back through work bots handed on:
 * - `message`: a message the person wrote (or their emoji);
 * - `routine`: a routine the person saved, run on its schedule or by hand, whose instructions are
 *   their words; a run a mail, a webhook or a watched page started is not;
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

/** Whether the work goes back to a message the person wrote (see `requestedBy`). */
export const personAsked = async (ctx: Ctx, turn: TurnRow): Promise<boolean> =>
  (await requestedBy(ctx, turn)) === 'message';

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

/** A question a bot asked the person on a card, and what the person chose or wrote on it. */
export interface CardAnswer {
  /** Written by the bot: it says what the answer agrees to, but is not the person's words. */
  question: string;
  /** The person's own: the option they picked or the text they typed on the card. */
  answer: string;
}

/** How many of the person's latest card answers count. */
const RECENT_ANSWERS = 5;

/**
 * The person's answers on a bot's question cards, behind the same work as `ownerWords`: a choice
 * such as "Write them all" is the go-ahead for what the question asked. Only cards a bot asked
 * with its question tool, answered by the person, since the oldest of the messages `ownerWords`
 * reads; a secret answer never. The question is the bot's text, so the reviewer may quote only
 * the answer.
 */
export async function ownerAnswers(ctx: Ctx, turn: TurnRow, hops = 0): Promise<CardAnswer[]> {
  if (turn.source === 'user' || turn.source === 'reaction') return personAnswers(ctx, turn.threadId);
  if (turn.source === 'routine') return [];
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
    return from ? ownerAnswers(ctx, from, hops + 1) : [];
  }
  const [thread] = await ctx.db
    .select({ kind: schema.threads.kind })
    .from(schema.threads)
    .where(eq(schema.threads.id, turn.threadId))
    .limit(1);
  return thread?.kind === 'room' ? personAnswers(ctx, turn.threadId) : [];
}

async function personAnswers(ctx: Ctx, threadId: string): Promise<CardAnswer[]> {
  const said = await ctx.db
    .select({ at: schema.messages.createdAt })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.threadId, threadId),
        eq(schema.messages.role, 'user'),
        eq(schema.messages.author, 'user'),
      ),
    )
    .orderBy(desc(schema.messages.createdAt))
    .limit(RECENT);
  const since = said.at(-1)?.at;
  const rows = await ctx.db
    .select()
    .from(schema.approvals)
    .where(
      and(
        eq(schema.approvals.threadId, threadId),
        eq(schema.approvals.kind, 'question'),
        eq(schema.approvals.toolName, 'ask_user'),
        eq(schema.approvals.status, 'allowed'),
        eq(schema.approvals.decidedBy, 'person'),
        ...(since ? [gte(schema.approvals.decidedAt, since)] : []),
      ),
    )
    .orderBy(desc(schema.approvals.decidedAt))
    .limit(RECENT_ANSWERS);
  const answers: CardAnswer[] = [];
  for (const r of rows.reverse()) {
    const { items } = questionItems({ input: r.input, summary: r.summary, options: r.options });
    const given = parseAnswers(r.answer, items.length);
    items.forEach((q, i) => {
      const answer = given[i]?.trim();
      if (!q.secret && answer)
        answers.push({ question: truncate(q.question, EACH), answer: truncate(answer, EACH) });
    });
  }
  return answers;
}

/** Text compared loosely: case, spacing, quote marks and punctuation do not matter. */
const loose = (s: string) =>
  s
    .toLocaleLowerCase('tr')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** The shortest quote that is not a whole message of the person's: a few words, not a syllable. */
const MIN_QUOTE_CHARS = 12;
const MIN_QUOTE_WORDS = 2;

/**
 * Whether the reviewer's quote is really in the person's words. A reviewer that lets an action run
 * must point at what was said; a quote that is not there, or too short to mean anything, does not
 * count, whatever the reviewer was persuaded of. The quote is matched as whole words, and is
 * either one of the person's messages as a whole or a stretch of a few words of one: a bit such
 * as "ok" or "the" is found in almost anything.
 */
export function quoteFound(quote: string, words: readonly string[]): boolean {
  const q = loose(quote);
  if (q.length < 2) return false;
  return words.some((w) => {
    const said = loose(w);
    if (said === q) return true;
    if (q.length < MIN_QUOTE_CHARS || q.split(' ').length < MIN_QUOTE_WORDS) return false;
    return ` ${said} `.includes(` ${q} `);
  });
}
