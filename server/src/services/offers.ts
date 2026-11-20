import type { Bot, Message } from '@leafbot/shared';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import type { Engine, TurnOutcome } from '../engine/types';
import { translator } from '../i18n';
import { asOutsideData } from '../runtime/outside';
import type { TurnRow } from '../runtime/turns';
import { HttpError, newId, truncate } from '../util';
import { redactSecrets } from './secrets';
import type { Services } from './index';

/** The person's own conversations with a bot; a room, a routine's or a team's work is not looked at. */
const OFFERED_KINDS = ['user'];
/** How much of the conversation the model reads: its latest messages, each cut short. */
const READ_MESSAGES = 8;
const READ_CHARS = 1200;
/** A conversation is looked at no more often than this, and a person gets at most this many offers a day. */
const THREAD_GAP_MS = 6 * 3600_000;
const PER_DAY = 3;
/** A look that has not answered by then is dropped. */
const WAIT_MS = 60_000;
const OFFER_MAX = 300;
const TASK_MAX = 1000;

export interface WorkOffer {
  offer: string;
  task: string;
}

/** The model's answer as an offer; anything else, an empty offer included, is none. */
export function parseOffer(text: string): WorkOffer | null {
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return null;
  try {
    const v = JSON.parse(json) as { offer?: unknown; task?: unknown };
    if (typeof v.offer !== 'string' || typeof v.task !== 'string') return null;
    const offer = v.offer.trim();
    const task = v.task.trim();
    if (!offer || !task) return null;
    return { offer: truncate(offer, OFFER_MAX), task: truncate(task, TASK_MAX) };
  } catch {
    return null;
  }
}

/**
 * After a person's message is answered, the bot looks over the conversation once more and may
 * offer one piece of follow-up work it could take on: a card the person accepts, which sends the
 * task as their own message, or turns down. Most looks find nothing. It never offers to reach
 * other people, spend or delete, and it is held back in how often it looks, so it helps without
 * becoming noise or a cost of its own.
 */
export class OfferService {
  private pending = new Set<Promise<void>>();
  private controllers = new Set<AbortController>();
  private stopped = false;
  /** When each conversation was last looked at, and how many offers each person got on a day. */
  private lookedAt = new Map<string, number>();
  private daily = new Map<string, number>();

  constructor(
    private ctx: Ctx,
    private services: Services,
    private engineFor: (bot: Bot) => Engine,
    private clock: () => Date = () => new Date(),
  ) {}

  /** Looked at after the turn's hooks, so the turn ends without waiting on the model. */
  onTurnFinished(turn: TurnRow, outcome: TurnOutcome): Promise<void> {
    if (!outcome.ok || turn.source !== 'user' || turn.guest || turn.rehearsalId || this.stopped)
      return Promise.resolve();
    const work = this.look(turn).catch((err: unknown) =>
      console.warn(`Work offer for ${turn.threadId} failed: ${(err as Error).message}`),
    );
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
    return Promise.resolve();
  }

  /** Waits for the looks under way (tests, shutdown). */
  async idle() {
    await Promise.allSettled([...this.pending]);
  }

  async shutdown() {
    this.stopped = true;
    for (const c of this.controllers) c.abort();
    await this.idle();
  }

  /**
   * The person's answer on an offer card: taken sends its task as their message in the same
   * conversation; turned down only marks the card. An offer is answered once.
   */
  async answer(messageId: string, take: boolean, userId: string): Promise<Message> {
    const m = await this.services.threads.message(messageId);
    if (m.props.kind !== 'offer' || typeof m.props.task !== 'string')
      throw new HttpError(400, 'error.notOffer');
    if (m.props.answer) throw new HttpError(409, 'error.offerAnswered');
    const answer = take ? 'taken' : 'declined';
    // Taken in one step with the check, so two answers at once (a double press, two devices) do
    // not both get through and send the task twice.
    const claimed = await this.ctx.db
      .update(schema.messages)
      .set({ props: sql`${schema.messages.props} || ${JSON.stringify({ answer })}::jsonb` })
      .where(and(eq(schema.messages.id, m.id), sql`${schema.messages.props}->>'answer' is null`))
      .returning({ id: schema.messages.id });
    if (!claimed.length) throw new HttpError(409, 'error.offerAnswered');
    // Through the usual path too, so the app hears of the answer.
    await this.services.threads.mergeProps(m.id, { answer });
    if (take) await this.services.inbox.send(m.threadId, { text: m.props.task, userId });
    return this.services.threads.message(m.id);
  }

  /** Drops what no longer holds anything back: looks older than the gap, and other days' counts. */
  private forget(now: number, today: string) {
    for (const [id, at] of this.lookedAt) if (now - at >= THREAD_GAP_MS) this.lookedAt.delete(id);
    for (const key of this.daily.keys()) if (!key.endsWith(`:${today}`)) this.daily.delete(key);
  }

  private async look(turn: TurnRow) {
    const thread = await this.services.threads.row(turn.threadId).catch(() => null);
    if (!thread || !OFFERED_KINDS.includes(thread.kind)) return;
    const person = turn.userId ?? thread.userId;
    if (!person) return;
    const settings = await this.services.settings.all(person);
    if (!settings.workOffers) return;
    const now = this.clock().getTime();
    const today = this.clock().toISOString().slice(0, 10);
    this.forget(now, today);
    if (now - (this.lookedAt.get(thread.id) ?? 0) < THREAD_GAP_MS) return;
    const day = `${person}:${today}`;
    if ((this.daily.get(day) ?? 0) >= PER_DAY) return;
    const bot = await this.services.bots.get(turn.botId).catch(() => null);
    if (!bot || bot.archivedAt || (await this.services.bots.isPaused(bot))) return;
    if (await this.services.usage.reached(bot)) return;
    const engine = this.engineFor(bot);
    if (!engine.complete) return;

    const said = await this.ctx.db
      .select({ role: schema.messages.role, text: schema.messages.text, props: schema.messages.props })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.threadId, thread.id),
          inArray(schema.messages.role, ['user', 'assistant', 'system']),
        ),
      )
      .orderBy(desc(schema.messages.createdAt), desc(schema.messages.id))
      .limit(READ_MESSAGES * 2);
    // An offer still waiting for an answer is enough: a second one would only crowd it.
    if (
      said.some(
        (m) => (m.props as { kind?: string }).kind === 'offer' && !(m.props as { answer?: string }).answer,
      )
    )
      return;
    const talk = said
      .filter((m) => m.role !== 'system')
      .slice(0, READ_MESSAGES)
      .reverse();
    if (!talk.some((m) => m.role === 'assistant')) return;
    this.lookedAt.set(thread.id, now);

    const locale = settings.language ?? (await this.services.settings.locale());
    const t = translator(locale);
    const lines = talk
      .map(
        (m) => `${m.role === 'user' ? t('offer.person') : bot.name}: ${truncate(m.text.trim(), READ_CHARS)}`,
      )
      .join('\n\n');
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), WAIT_MS);
    let text: string;
    let costUsd: number | null;
    try {
      ({ text, costUsd } = await engine.complete({
        model:
          bot.model || (bot.engine === 'claude' ? settings.defaultModel : '') || this.ctx.config.claudeModel,
        system: t('offer.system', { bot: bot.name, description: bot.description || '-' }),
        // What was said is the conversation's, read as data: a message cannot make the bot offer.
        user: asOutsideData(t('offer.source'), lines, t),
        signal: controller.signal,
        locale,
      }));
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
    }
    if (controller.signal.aborted) return;
    const offer = parseOffer(text);
    await this.ctx.db
      .insert(schema.workOfferChecks)
      .values({ id: newId(), botId: bot.id, costUsd, found: !!offer, createdAt: this.clock() });
    if (!offer) return;
    // The person may have written again meanwhile: an offer on a moved-on conversation is stale.
    const [latest] = await this.ctx.db
      .select({ role: schema.messages.role })
      .from(schema.messages)
      .where(
        and(eq(schema.messages.threadId, thread.id), inArray(schema.messages.role, ['user', 'assistant'])),
      )
      .orderBy(desc(schema.messages.createdAt), desc(schema.messages.id))
      .limit(1);
    if (latest?.role !== 'assistant') return;
    this.daily.set(day, (this.daily.get(day) ?? 0) + 1);
    const marker = t('memory.redacted');
    await this.services.threads.addMessage({
      threadId: thread.id,
      role: 'system',
      author: `bot:${bot.id}`,
      text: redactSecrets(offer.offer, marker).text,
      props: { kind: 'offer', task: redactSecrets(offer.task, marker).text },
    });
  }
}
