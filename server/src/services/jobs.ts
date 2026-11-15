import type { Bot } from '@yumakbot/shared';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import type { TurnOutcome } from '../engine/types';
import type { TurnRow } from '../runtime/turns';
import { HttpError, newId, notFound, truncate } from '../util';
import type { Services } from '.';
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
      props: { jobId: job.id },
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
    });
    return job;
  }

  /** Turn hook: when a job's target turn ends, deliver the reply to the sender. */
  async onTurnFinished(turn: TurnRow, outcome: TurnOutcome) {
    if (!turn.jobId || turn.source !== 'bot') return;
    const job = await this.get(turn.jobId).catch(() => null);
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
    });
  }

  private async markReplied(job: JobRow) {
    const rows = await this.ctx.db
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.threadId, job.fromThreadId), eq(schema.messages.role, 'marker')));
    const marker = rows.find((m) => (m.props as { jobId?: string }).jobId === job.id);
    if (!marker) return;
    const count = await this.ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.threadId, job.toThreadId),
          sql`${schema.messages.role} in ('user','assistant')`,
        ),
      );
    await this.services.threads.updateMessage(marker.id, {
      props: { ...(marker.props as object), count: Number(count[0]?.n ?? 2), replied: true },
    });
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
