import type { Bot, Message, OutsideTrigger } from '@yumakbot/shared';
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import type { TurnOutcome } from '../engine/types';
import type { TurnRow } from '../runtime/turns';
import { HttpError, newId, notFound, truncate } from '../util';
import type { Services } from '.';
import { toMessage } from './mappers';
import { serverTranslator } from './settings';

type JobRow = typeof schema.jobs.$inferSelect;

/**
 * Bot-to-bot requests. Sending never blocks the sender: the target gets a turn in its
 * thread for that peer, and the reply comes back to the sender as a new turn.
 */
export class JobService {
  constructor(
    private ctx: Ctx,
    private services: Services,
  ) {}

  async get(id: string): Promise<JobRow> {
    const [row] = await this.ctx.db.select().from(schema.jobs).where(eq(schema.jobs.id, id)).limit(1);
    if (!row) throw notFound('job');
    return row;
  }

  async send(opts: {
    from: Bot;
    fromThreadId: string;
    /** The sender's turn, so that replies to one turn come back in one. */
    fromTurnId?: string | null;
    /** The turn making the request; its job (if any) is the parent in the chain. */
    parentJobId: string | null;
    to: Bot;
    text: string;
    kind: 'send' | 'ask' | 'notify';
    approvalId?: string | null;
    /**
     * Outside text the sender's run had read: its request may carry those words, so the target's
     * turn counts as having read them too.
     */
    outside?: OutsideTrigger | null;
  }): Promise<JobRow> {
    const { from, to } = opts;
    if (!this.services.bots.canMessage(from, to)) {
      throw new HttpError(403, 'error.cannotMessage', { from: from.name, to: to.name });
    }
    const parent = opts.parentJobId ? await this.get(opts.parentJobId).catch(() => null) : null;
    const depth = parent ? parent.depth + 1 : 1;
    const rootId = parent ? parent.rootId : newId();
    if (depth > this.ctx.config.maxJobDepth) {
      throw new HttpError(429, 'error.chainTooDeep', { depth });
    }
    const [{ n } = { n: 0 }] = await this.ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.jobs)
      .where(eq(schema.jobs.rootId, rootId));
    if (Number(n) >= this.ctx.config.maxJobsPerChain) {
      throw new HttpError(429, 'error.chainBudget');
    }
    const t = await serverTranslator(this.ctx);
    let approvalNote = '';
    if (opts.approvalId) {
      const approval = await this.services.approvals.verifiedApproval(opts.approvalId);
      if (!approval) throw new HttpError(400, 'error.approvalNotVerified');
      const answer = approval.answer
        ? t('job.approvalAnswer', { answer: truncate(approval.answer, 200) })
        : '';
      approvalNote = `\n\n${t('job.approvalNote', { id: approval.id, summary: truncate(approval.summary, 160), answer })}`;
    }
    const toThread = await this.services.threads.peerThread(to.id, from.id);
    const job: JobRow = {
      id: newId(),
      rootId,
      depth,
      kind: opts.kind,
      fromBotId: from.id,
      toBotId: to.id,
      fromThreadId: opts.fromThreadId,
      fromTurnId: opts.fromTurnId ?? null,
      toThreadId: toThread.id,
      approvalId: opts.approvalId ?? null,
      request: opts.text,
      reply: null,
      status: 'pending',
      createdAt: new Date(),
      finishedAt: null,
      deliveredAt: null,
    };
    await this.ctx.db.insert(schema.jobs).values(job);
    await this.services.threads.addMessage({
      threadId: toThread.id,
      role: 'user',
      author: `bot:${from.id}`,
      text: opts.text,
      props: { jobId: job.id, ...(opts.outside && { outside: opts.outside }) },
    });
    // One-line marker in the sender's thread; expands to the bot conversation.
    await this.services.threads.addMessage({
      threadId: opts.fromThreadId,
      role: 'marker',
      author: `bot:${from.id}`,
      text: t('job.marker', { to: to.name }),
      props: { jobId: job.id, peerBotId: to.id, peerThreadId: toThread.id, count: 1, direction: 'out' },
    });
    const prompt = t(opts.kind === 'notify' ? 'job.notice' : 'job.request', {
      from: from.name,
      text: opts.text,
      note: approvalNote,
    });
    await this.services.turns.enqueue({
      threadId: toThread.id,
      botId: to.id,
      source: 'bot',
      prompt,
      jobId: job.id,
      outside: opts.outside ?? null,
    });
    return job;
  }

  /** Turn hook: when a job's target turn ends, deliver the reply to the sender. */
  async onTurnFinished(turn: TurnRow, outcome: TurnOutcome) {
    if (!turn.jobId || turn.source !== 'bot') return;
    const job = await this.get(turn.jobId).catch(() => null);
    if (job && job.fromThreadId === turn.threadId) await this.recountAnswered(job);
    if (!job || job.toThreadId !== turn.threadId || job.status !== 'pending') return;
    const t = await serverTranslator(this.ctx);
    const reply =
      outcome.text.trim() ||
      (outcome.ok ? t('job.emptyReply') : t('job.failedReply', { message: outcome.message }));
    const status = outcome.ok ? 'done' : outcome.kind === 'interrupted' ? 'stopped' : 'error';
    await this.ctx.db
      .update(schema.jobs)
      .set({ reply, status, finishedAt: new Date() })
      .where(and(eq(schema.jobs.id, job.id), eq(schema.jobs.status, 'pending')));
    const from = await this.services.bots.get(job.fromBotId).catch(() => null);
    if (!from || from.archivedAt) return;
    await this.markReplied(job);
    if (job.kind === 'notify') return;
    await this.deliver(job);
  }

  /**
   * Hands replies to the sender as one new turn. Requests made in the same turn wait for each
   * other, so a bot that asked several bots reads all their answers at once instead of answering
   * the person again after each.
   */
  private async deliver(job: JobRow) {
    const siblings = await this.ctx.db
      .select()
      .from(schema.jobs)
      .where(
        job.fromTurnId
          ? and(eq(schema.jobs.fromTurnId, job.fromTurnId), sql`${schema.jobs.kind} <> 'notify'`)
          : eq(schema.jobs.id, job.id),
      );
    if (siblings.some((j) => j.status === 'pending')) return;
    // Claimed in one statement: of two replies finishing at once, only one turn hands them over.
    const claimed = await this.ctx.db
      .update(schema.jobs)
      .set({ deliveredAt: new Date() })
      .where(
        and(
          inArray(
            schema.jobs.id,
            siblings.map((j) => j.id),
          ),
          isNull(schema.jobs.deliveredAt),
        ),
      )
      .returning();
    if (!claimed.length) return;
    claimed.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    // An answer written in a run that had read outside text carries those words back.
    const [read] = await this.ctx.db
      .select({ outside: schema.turns.outside })
      .from(schema.turns)
      .where(
        and(
          inArray(
            schema.turns.jobId,
            claimed.map((j) => j.id),
          ),
          isNotNull(schema.turns.outside),
        ),
      )
      .limit(1);
    const t = await serverTranslator(this.ctx);
    const parts: string[] = [];
    for (const j of claimed) {
      const to = await this.services.bots.get(j.toBotId).catch(() => null);
      parts.push(
        t('job.reply', {
          to: to?.name ?? '?',
          status: t(j.status === 'done' ? 'job.done' : 'job.failed'),
          reply: j.reply ?? '',
        }),
      );
    }
    await this.services.turns.enqueue({
      threadId: job.fromThreadId,
      botId: job.fromBotId,
      source: 'bot',
      prompt: parts.join('\n\n---\n\n'),
      jobId: claimed.at(-1)!.id,
      outside: read?.outside ?? null,
    });
  }

  /**
   * The messages of one request and the work it started: the request itself and what the target
   * bot wrote in the turns it ran for it, including the turns that read the answers of bots it
   * asked in turn. The thread of a pair of bots holds every request they ever exchanged; a marker
   * opens only to its own.
   */
  async exchange(job: JobRow): Promise<Message[]> {
    const thread = job.toThreadId;
    const turns = new Set(
      (
        await this.ctx.db
          .select({ id: schema.turns.id })
          .from(schema.turns)
          .where(and(eq(schema.turns.jobId, job.id), eq(schema.turns.threadId, thread)))
      ).map((r) => r.id),
    );
    // Answers to what those turns asked other bots come back as further turns here.
    let asking = [...turns];
    for (let i = 0; asking.length && i <= this.ctx.config.maxJobDepth; i++) {
      const asked = await this.ctx.db
        .select({ id: schema.jobs.id })
        .from(schema.jobs)
        .where(and(eq(schema.jobs.fromThreadId, thread), inArray(schema.jobs.fromTurnId, asking)));
      const answered = asked.length
        ? await this.ctx.db
            .select({ id: schema.turns.id })
            .from(schema.turns)
            .where(
              and(
                eq(schema.turns.threadId, thread),
                inArray(
                  schema.turns.jobId,
                  asked.map((j) => j.id),
                ),
              ),
            )
        : [];
      asking = answered.map((r) => r.id).filter((id) => !turns.has(id));
      for (const id of asking) turns.add(id);
    }
    const rows = await this.ctx.db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.threadId, thread),
          or(
            turns.size ? inArray(schema.messages.turnId, [...turns]) : undefined,
            sql`${schema.messages.props}->>'jobId' = ${job.id}`,
          ),
        ),
      )
      .orderBy(asc(schema.messages.createdAt), asc(schema.messages.id));
    return rows.map(toMessage);
  }

  private async markReplied(job: JobRow) {
    await this.recount(job, { replied: true });
  }

  /**
   * A turn that read answers of bots asked for a request belongs to that request's exchange, so
   * the markers of the requests this thread was working on count it too.
   */
  private async recountAnswered(answer: JobRow) {
    const asked = await this.ctx.db
      .select()
      .from(schema.jobs)
      .where(
        and(
          eq(schema.jobs.rootId, answer.rootId),
          eq(schema.jobs.toThreadId, answer.fromThreadId),
          sql`${schema.jobs.status} <> 'pending'`,
        ),
      );
    for (const job of asked) await this.recount(job);
  }

  /** Writes on the job's marker how many messages the open marker shows. */
  private async recount(job: JobRow, extra: Record<string, unknown> = {}, opts: { quiet?: boolean } = {}) {
    const rows = await this.ctx.db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.threadId, job.fromThreadId),
          eq(schema.messages.role, 'marker'),
          sql`${schema.messages.props}->>'jobId' = ${job.id}`,
        ),
      );
    const marker = rows[0];
    if (!marker) return;
    const count = Math.max(
      (await this.exchange(job)).filter((m) => m.role === 'user' || m.role === 'assistant').length,
      1,
    );
    const props = marker.props as Record<string, unknown>;
    if (props.count === count && Object.entries(extra).every(([k, v]) => props[k] === v)) return;
    const next = { ...props, ...extra, count };
    if (opts.quiet) {
      await this.ctx.db.update(schema.messages).set({ props: next }).where(eq(schema.messages.id, marker.id));
    } else {
      await this.services.threads.updateMessage(marker.id, { props: next });
    }
  }

  /**
   * Markers written before a marker opened to its own request counted every message the two bots
   * ever exchanged, so a closed line showed more than it opened to. Counted again once.
   */
  async recountMarkers() {
    const KEY = 'jobs.markerCounts';
    const [done] = await this.ctx.db.select().from(schema.kv).where(eq(schema.kv.key, KEY)).limit(1);
    if (done) return;
    const markers = await this.ctx.db
      .select({ jobId: sql<string>`${schema.messages.props}->>'jobId'` })
      .from(schema.messages)
      .where(and(eq(schema.messages.role, 'marker'), sql`${schema.messages.props}->>'jobId' is not null`));
    for (const { jobId } of markers) {
      const job = await this.get(jobId).catch(() => null);
      if (!job || job.status === 'pending') continue;
      await this.recount(job, {}, { quiet: true });
    }
    await this.ctx.db.insert(schema.kv).values({ key: KEY, value: true }).onConflictDoNothing();
  }

  async status(botId: string) {
    const threads = await this.services.threads.list(botId);
    const running = threads.filter((t) => t.state !== 'idle');
    const pending = await this.ctx.db
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.toBotId, botId), eq(schema.jobs.status, 'pending')));
    return {
      busy: running.length > 0,
      threads: running.map((t) => ({ id: t.id, state: t.state })),
      pendingJobs: pending.length,
    };
  }

  /**
   * When the person stops a conversation, the work its bot gave other bots stops too, and so on
   * down the chain. No reply comes back to wake the stopped bot. Returns how many bots stopped.
   */
  async stopFrom(threadId: string, depth = 0): Promise<number> {
    if (depth > this.ctx.config.maxJobDepth) return 0;
    const open = await this.ctx.db
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.fromThreadId, threadId), eq(schema.jobs.status, 'pending')));
    if (!open.length) return 0;
    await this.ctx.db
      .update(schema.jobs)
      .set({ deliveredAt: new Date() })
      .where(
        inArray(
          schema.jobs.id,
          open.map((j) => j.id),
        ),
      );
    let stopped = 0;
    for (const job of open) {
      if (await this.services.turns.stopJob(job.id)) stopped++;
      stopped += await this.stopFrom(job.toThreadId, depth + 1);
    }
    return stopped;
  }

  /** Stop the target turn of a job. */
  async stop(jobId: string, requester: Bot) {
    const job = await this.get(jobId);
    if (job.fromBotId !== requester.id && !requester.isManager) {
      throw new HttpError(403, 'error.jobStopForbidden');
    }
    await this.services.turns.interrupt(job.toThreadId);
    return job;
  }
}
