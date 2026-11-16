import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { RoutineUpdate } from '@yumakbot/shared';
import {
  nextRun,
  zonedTime,
  occurrenceKey,
  passesFilter,
  type Routine,
  type RoutineCreate,
  type RoutineRun,
  type Schedule,
} from '@yumakbot/shared';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, ne, notExists, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { Ctx } from '../context';
import type { T } from '../i18n';
import { SILENT_REPLY } from '../engine/types';
import { schema } from '../db';
import type { Engine, GateRequest, GateVerdict, TurnOutcome } from '../engine/types';
import type { TurnRow } from '../runtime/turns';
import { cutAt, HttpError, isUniqueViolation, newId, notFound } from '../util';
import { toRoutine, toRun } from './mappers';
import { fetchPublicText } from './skill-link';
import type { Services } from '.';

/** The largest watched page read, and how much of its text goes to the bot. */
const WATCH_MAX = 2 * 1024 * 1024;
const WATCH_EXCERPT = 6000;
/** How much of a watched page's text is kept to show the next change as what changed. */
const WATCH_KEEP = 200_000;
/** The most of each side of a page change the pre-check reads. */
const DIFF_MAX = 3000;

/**
 * What changed between two readings of a page, as the sentences removed and added. A page's text
 * is one long line, so it is compared sentence by sentence; null when nothing differs that way.
 */
export function pageDiff(before: string, after: string): string | null {
  const parts = (text: string) =>
    text
      .split(/(?<=[.!?;:|•])\s+/)
      .map((p) => p.trim())
      .filter(Boolean);
  const was = new Set(parts(before));
  const now = new Set(parts(after));
  const removed = [...was].filter((p) => !now.has(p));
  const added = [...now].filter((p) => !was.has(p));
  if (!removed.length && !added.length) return null;
  const side = (label: string, list: string[]) =>
    list.length ? `${label}:\n${cutAt(list.map((p) => `- ${p}`).join('\n'), DIFF_MAX)}` : `${label}: (none)`;
  return `${side('Removed', removed)}\n\n${side('Added', added)}`;
}

/** A page's readable text: no scripts, styles or tags, spaces collapsed, so markup churn is not a change. */
export function pageText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The longest previous report carried into a run. */
const REPORT_MAX = 4000;

/** The report inside markers it cannot close itself, so it stays read as data. */
export function fence(report: string): string {
  return `<<<\n${report.replaceAll('>>>', '> > >')}\n>>>`;
}

export class RoutineService {
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  private stopped = false;
  /** Runs whose pre-check is under way; their turn starts when it answers. */
  private checking = new Set<Promise<void>>();
  private stopChecks = new AbortController();

  constructor(
    private ctx: Ctx,
    private services: Services,
    private clock: () => Date = () => new Date(),
    /** The engine whose small model does the pre-check. */
    private checker?: () => Engine,
  ) {}

  start() {
    this.stopped = false;
    if (this.stopChecks.signal.aborted) this.stopChecks = new AbortController();
    if (!this.ctx.config.routinesEnabled || this.timer) return;
    void this.runStartup();
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.ctx.config.routineTickMs);
    this.timer.unref();
  }

  /** Stops the schedule and waits for a tick under way, so it does not outlive the database. */
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.ticking;
    this.stopChecks.abort();
    await this.settled();
  }

  /** Waits for the pre-checks under way and the turns they start to be queued. */
  async settled() {
    while (this.checking.size) await Promise.all([...this.checking]);
  }

  /**
   * End runs left active with no turn to finish them: the server stopped between recording the
   * run and queueing its turn. Without this the routine would be skipped as "still running"
   * forever. Call after the turns' own recovery, which ends runs whose turn was cut short.
   */
  async recover() {
    const t = await this.services.settings.translator();
    const orphaned = await this.ctx.db
      .update(schema.routineRuns)
      .set({ status: 'error', reason: t('turn.serverRestarted'), finishedAt: this.clock() })
      .where(
        and(
          inArray(schema.routineRuns.status, ['running', 'waiting']),
          notExists(
            this.ctx.db
              .select({ id: schema.turns.id })
              .from(schema.turns)
              .where(
                and(
                  eq(schema.turns.routineRunId, schema.routineRuns.id),
                  inArray(schema.turns.status, ['queued', 'running']),
                ),
              ),
          ),
        ),
      )
      .returning({ id: schema.routineRuns.id });
    if (orphaned.length) this.ctx.bus.refresh({ scope: 'routines' });
  }

  /** Runs each enabled routine set to run when the server starts, once for this start. */
  async runStartup() {
    const due = await this.ctx.db
      .select()
      .from(schema.routines)
      .where(and(eq(schema.routines.enabled, true), eq(schema.routines.onStartup, true)));
    const at = `startup:${this.clock().toISOString()}`;
    for (const row of due) {
      await this.fire(toRoutine(row), at).catch((err) =>
        console.warn(`Startup run of routine ${row.id} failed: ${String(err)}`),
      );
    }
  }

  async list(botId?: string): Promise<Routine[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.routines)
      .where(botId ? eq(schema.routines.botId, botId) : undefined)
      .orderBy(asc(schema.routines.createdAt));
    return rows.map(toRoutine);
  }

  async get(id: string): Promise<Routine> {
    const [row] = await this.ctx.db.select().from(schema.routines).where(eq(schema.routines.id, id)).limit(1);
    if (!row) throw notFound('routine');
    return toRoutine(row);
  }

  async create(input: RoutineCreate): Promise<Routine> {
    await this.services.bots.get(input.botId);
    const now = this.clock();
    this.checkOnce(input.schedule, input.timezone, now);
    const [row] = await this.ctx.db
      .insert(schema.routines)
      .values({
        id: newId(),
        ...input,
        nextRunAt: input.enabled ? nextRun(input.schedule, input.timezone, now) : null,
      })
      .returning();
    this.ctx.bus.refresh({ scope: 'routines' });
    return toRoutine(row!);
  }

  async update(id: string, patch: z.infer<typeof RoutineUpdate>): Promise<Routine> {
    const current = await this.get(id);
    const schedule = (patch.schedule ?? current.schedule) as Schedule;
    const timezone = patch.timezone ?? current.timezone;
    const enabled = patch.enabled ?? current.enabled;
    const last = current.lastRunAt ? new Date(current.lastRunAt) : null;
    if (patch.schedule) this.checkOnce(schedule, timezone, this.clock());
    const [row] = await this.ctx.db
      .update(schema.routines)
      .set({ ...patch, nextRunAt: enabled ? nextRun(schedule, timezone, this.clock(), last) : null })
      .where(eq(schema.routines.id, id))
      .returning();
    // Pausing a routine also ends a run of it that waits on the person; one at work goes on.
    if (current.enabled && !enabled) {
      const t = await this.services.settings.translator();
      await this.endStaleWait(id, t, 0, 'routine.pausedWait');
    }
    this.ctx.bus.refresh({ scope: 'routines' });
    return toRoutine(row!);
  }

  /** A one-time run must be ahead; one set in the past would run at once by surprise. */
  private checkOnce(s: Schedule, tz: string, now: Date) {
    if (s.type === 'once' && zonedTime(s.date, s.time, tz).getTime() < now.getTime() - 60_000) {
      throw new HttpError(400, 'validation.datePast');
    }
  }

  async remove(id: string) {
    // Work the routine queued and nobody started goes with it; a run under way finishes.
    const queued = await this.ctx.db
      .select({ id: schema.turns.id })
      .from(schema.turns)
      .innerJoin(schema.routineRuns, eq(schema.routineRuns.id, schema.turns.routineRunId))
      .where(and(eq(schema.routineRuns.routineId, id), eq(schema.turns.status, 'queued')));
    for (const turn of queued) await this.services.turns.cancelQueued(turn.id);
    await this.ctx.db.delete(schema.routines).where(eq(schema.routines.id, id));
    this.ctx.bus.refresh({ scope: 'routines' });
  }

  async runs(routineId: string, limit = 30): Promise<RoutineRun[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.routineRuns)
      .where(eq(schema.routineRuns.routineId, routineId))
      .orderBy(desc(schema.routineRuns.startedAt))
      .limit(limit);
    // A run whose turn has not started yet waits for its bot to finish something else: it reads as
    // in line, not as running, and says why.
    const active = rows.filter((r) => r.status === 'running').map((r) => r.id);
    const queued = active.length
      ? new Set(
          (
            await this.ctx.db
              .select({ run: schema.turns.routineRunId })
              .from(schema.turns)
              .where(and(inArray(schema.turns.routineRunId, active), eq(schema.turns.status, 'queued')))
          ).map((x) => x.run),
        )
      : new Set<string | null>();
    if (!queued.size) return rows.map(toRun);
    const t = await this.services.settings.translator();
    return rows.map((r) =>
      queued.has(r.id)
        ? { ...toRun(r), status: 'waiting' as const, reason: t('routine.waitingForBot') }
        : toRun(r),
    );
  }

  /** Fire every due routine once. Safe to call concurrently and repeatedly. */
  async tick() {
    if (this.ticking || this.stopped) return;
    this.ticking = this.runDue().finally(() => {
      this.ticking = null;
    });
    await this.ticking;
  }

  private async runDue() {
    try {
      const now = this.clock();
      const due = await this.ctx.db
        .select()
        .from(schema.routines)
        .where(
          and(
            eq(schema.routines.enabled, true),
            isNotNull(schema.routines.nextRunAt),
            lte(schema.routines.nextRunAt, now),
          ),
        );
      const t = await this.services.settings.translator();
      // The routine as it is now: one paused, edited or deleted during this tick (a watched page
      // takes a while to read) is not run from the copy read at its start.
      const current = async (r: (typeof due)[number]) => {
        const [row] = await this.ctx.db.select().from(schema.routines).where(eq(schema.routines.id, r.id));
        return row?.enabled && row.nextRunAt?.getTime() === r.nextRunAt!.getTime() ? row : null;
      };
      for (const listed of due) {
        const r = await current(listed);
        if (!r) continue;
        const schedule = r.schedule as Schedule;
        const late = now.getTime() - r.nextRunAt!.getTime() > MISSED_GRACE_MS;
        if (late && r.missed === 'skip') {
          await this.record(toRoutine(r), occurrenceKey(r.nextRunAt!), 'skipped', t('routine.missedSkipped'));
        } else if (r.watchUrl) {
          // A watched page is read with no AI; the bot runs only when the page changed.
          const changed = await this.pageChanged(r.id, r.watchUrl, r.watchHash, r.watchText);
          const still = changed !== null ? await current(r) : null;
          if (changed !== null && still) {
            await this.fire(
              toRoutine(still),
              occurrenceKey(r.nextRunAt!),
              t('routine.watchChanged', { url: r.watchUrl, text: changed.excerpt }),
              false,
              // Without the earlier text the check reads the page as it is now.
              { trigger: 'watch', input: changed.diff ?? changed.excerpt },
            );
          }
        } else {
          await this.fire(toRoutine(r), occurrenceKey(r.nextRunAt!));
        }
        // A one-time routine stays as a paused record after its run.
        await this.ctx.db
          .update(schema.routines)
          .set(
            schedule.type === 'once'
              ? { nextRunAt: null, enabled: false }
              : { nextRunAt: nextRun(schedule, r.timezone, now, r.nextRunAt) },
          )
          // A schedule the person changed meanwhile keeps the next run they set.
          .where(and(eq(schema.routines.id, r.id), eq(schema.routines.nextRunAt, r.nextRunAt!)));
      }
      if (due.length) this.ctx.bus.refresh({ scope: 'routines' });
    } catch (err) {
      console.error('routine tick', err);
    }
  }

  /**
   * Reads a watched page and keeps its fingerprint and text. Returns the page's text, and what
   * changed when the earlier text was kept, when it changed since the last read; null when it did
   * not, could not be read, or is read for the first time (that read sets what later ones are
   * compared with).
   */
  async pageChanged(
    routineId: string,
    url: string,
    before: string | null,
    beforeText: string | null = null,
  ): Promise<{ excerpt: string; diff: string | null } | null> {
    let text: string;
    try {
      text = pageText(await fetchPublicText(new URL(url), WATCH_MAX));
    } catch (err) {
      console.warn(`Watched page of routine ${routineId} could not be read: ${String(err)}`);
      return null;
    }
    const hash = createHash('sha256').update(text).digest('hex');
    if (hash === before) return null;
    const kept = text.slice(0, WATCH_KEEP);
    await this.ctx.db
      .update(schema.routines)
      .set({ watchHash: hash, watchText: kept })
      .where(eq(schema.routines.id, routineId));
    if (before === null) return null;
    return {
      excerpt: text.slice(0, WATCH_EXCERPT),
      diff: beforeText === null ? null : pageDiff(beforeText, kept),
    };
  }

  /** Gives the routine a new webhook secret (the old address stops working), or removes it. */
  async setWebhook(id: string, on: boolean): Promise<Routine> {
    await this.get(id);
    const token = on ? randomBytes(24).toString('base64url') : null;
    await this.ctx.db.update(schema.routines).set({ webhookToken: token }).where(eq(schema.routines.id, id));
    this.ctx.bus.refresh({ scope: 'routines' });
    return this.get(id);
  }

  /** Runs the routine for a webhook call when `token` is its secret; null when it is not. */
  async runFromWebhook(
    id: string,
    token: string,
    payload?: string,
    /** The sender's id for this delivery, when it gives one; a delivery sent again runs once. */
    deliveryId?: string,
  ): Promise<RoutineRun | null | false | 'filtered' | 'duplicate' | 'busy'> {
    const [row] = await this.ctx.db
      .select({
        token: schema.routines.webhookToken,
        enabled: schema.routines.enabled,
        filter: schema.routines.webhookFilter,
        post: schema.routines.webhookPost,
      })
      .from(schema.routines)
      .where(eq(schema.routines.id, id))
      .limit(1);
    if (!row?.token || !row.enabled || !sameSecret(row.token, token)) return false;
    // A call the filter turns away starts nothing and costs nothing.
    if (row.filter.trim() && !passesFilter(row.filter, payload ?? '')) return 'filtered';
    const occurrence = deliveryId?.trim() ? `hook:${deliveryId.trim().slice(0, 200)}` : null;
    if (occurrence) {
      const [seen] = await this.ctx.db
        .select({ id: schema.routineRuns.id })
        .from(schema.routineRuns)
        .where(and(eq(schema.routineRuns.routineId, id), eq(schema.routineRuns.occurrence, occurrence)))
        .limit(1);
      if (seen) return 'duplicate';
    }
    if (row.post) return this.post(await this.get(id), payload ?? '', occurrence);
    // A call that finds a run still going is told to come back later, so the sender delivers the
    // event again instead of it being dropped. A run stuck on an unanswered card gives way first.
    const [active] = await this.ctx.db
      .select({ id: schema.routineRuns.id })
      .from(schema.routineRuns)
      .where(
        and(eq(schema.routineRuns.routineId, id), inArray(schema.routineRuns.status, ['running', 'waiting'])),
      )
      .limit(1);
    if (active) {
      const t = await this.services.settings.translator();
      if (!(await this.endStaleWait(id, t, STALE_WAIT_MS, 'routine.staleWait'))) return 'busy';
    }
    return this.fire(
      await this.get(id),
      occurrence ?? `manual:${this.clock().toISOString()}`,
      payload,
      false,
      // A call that carries nothing is only a "run now", with nothing to judge.
      payload?.trim() ? { trigger: 'webhook', input: payload } : undefined,
    );
  }

  /**
   * A notification-style webhook: what the call carries lands in the routine's conversation as the
   * bot's own message, with no AI turn and no cost. The run is recorded as done.
   */
  private async post(routine: Routine, payload: string, delivery: string | null): Promise<RoutineRun | null> {
    const t = await this.services.settings.translator();
    const bot = await this.services.bots.get(routine.botId).catch(() => null);
    const occurrence = delivery ?? `post:${this.clock().toISOString()}:${newId().slice(0, 8)}`;
    if (!bot || bot.archivedAt) return this.record(routine, occurrence, 'skipped', t('routine.botMissing'));
    const thread = await this.threadFor(routine, bot.id);
    const [run] = (await this.ctx.db
      .insert(schema.routineRuns)
      .values({
        id: newId(),
        routineId: routine.id,
        occurrence,
        status: 'done',
        threadId: thread.id,
        promptSnapshot: routine.prompt,
        finishedAt: this.clock(),
      })
      .returning()) as [typeof schema.routineRuns.$inferSelect];
    await this.ctx.db
      .update(schema.routines)
      .set({ lastRunAt: this.clock() })
      .where(eq(schema.routines.id, routine.id));
    await this.services.threads.addMessage({
      threadId: thread.id,
      role: 'assistant',
      author: `bot:${bot.id}`,
      text: payload.trim() ? cutAt(payload.trim(), POST_MAX) : t('routine.postEmpty', { name: routine.name }),
      props: { routineRunId: run.id, routineName: routine.name, posted: true },
    });
    this.ctx.bus.refresh({ scope: 'routines' });
    return toRun(run);
  }

  /**
   * Run now, outside the schedule. `payload` is what a script or another service hands over with
   * the run (a build log, a webhook body); the bot reads it as data after its instruction.
   */
  async runNow(id: string, payload?: string): Promise<RoutineRun | null> {
    const routine = await this.get(id);
    return this.fire(routine, `manual:${this.clock().toISOString()}`, payload);
  }

  /** Where a routine's runs write: the bot's main conversation, or the routine's own, reused. */
  private async threadFor(routine: Routine, botId: string) {
    if (routine.inMain) return this.services.threads.row((await this.services.threads.main(botId)).id);
    const [last] = await this.ctx.db
      .select({ threadId: schema.routineRuns.threadId })
      .from(schema.routineRuns)
      .where(and(eq(schema.routineRuns.routineId, routine.id), isNotNull(schema.routineRuns.threadId)))
      .orderBy(desc(schema.routineRuns.startedAt))
      .limit(1);
    return this.services.threads.routineThread(botId, routine.name, last?.threadId ?? null);
  }

  /**
   * Ends the routine's active run when it has been waiting on a card for the person for `minAge`
   * or more, recording why: with STALE_WAIT_MS one unanswered question does not stop every later
   * run, with 0 a paused routine leaves nothing waiting. True when it ended one.
   */
  private async endStaleWait(
    routineId: string,
    t: T,
    minAge: number,
    reason: 'routine.staleWait' | 'routine.pausedWait',
  ): Promise<boolean> {
    const [stuck] = await this.ctx.db
      .select({ runId: schema.routineRuns.id, turnId: schema.turns.id })
      .from(schema.routineRuns)
      .innerJoin(schema.turns, eq(schema.turns.routineRunId, schema.routineRuns.id))
      .innerJoin(schema.approvals, eq(schema.approvals.turnId, schema.turns.id))
      .where(
        and(
          eq(schema.routineRuns.routineId, routineId),
          inArray(schema.routineRuns.status, ['running', 'waiting']),
          eq(schema.turns.status, 'running'),
          eq(schema.approvals.status, 'pending'),
          // Card times are the database's own clock.
          lte(schema.approvals.createdAt, sql`now() - make_interval(secs => ${minAge / 1000})`),
        ),
      )
      .limit(1);
    if (!stuck) return false;
    await this.services.turns.stopTurn(stuck.turnId);
    await this.ctx.db
      .update(schema.routineRuns)
      .set({ status: 'error', reason: t(reason), finishedAt: this.clock() })
      .where(eq(schema.routineRuns.id, stuck.runId));
    return true;
  }

  /**
   * Records a run and starts the bot on it. With `check` (a watched page changed, a webhook carried
   * something) and the pre-check on, a small model looks at the run first: the run is recorded at
   * once and its turn starts when the check answers, so a webhook caller is not kept waiting.
   */
  private async fire(
    routine: Routine,
    occurrence: string,
    payload?: string,
    retried = false,
    check?: { trigger: GateRequest['trigger']; input: string },
  ): Promise<RoutineRun | null> {
    const t = await this.services.settings.translator();
    const bot = await this.services.bots.get(routine.botId).catch(() => null);
    if (!bot || bot.archivedAt) return this.record(routine, occurrence, 'skipped', t('routine.botMissing'));
    const thread = await this.threadFor(routine, bot.id);
    let run: typeof schema.routineRuns.$inferSelect;
    try {
      [run] = (await this.ctx.db
        .insert(schema.routineRuns)
        .values({
          id: newId(),
          routineId: routine.id,
          occurrence,
          status: 'running',
          threadId: thread.id,
          promptSnapshot: routine.prompt,
        })
        .returning()) as [typeof schema.routineRuns.$inferSelect];
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Same occurrence already handled, or a run is still active.
      const [dup] = await this.ctx.db
        .select()
        .from(schema.routineRuns)
        .where(
          and(eq(schema.routineRuns.routineId, routine.id), eq(schema.routineRuns.occurrence, occurrence)),
        )
        .limit(1);
      if (dup) return null;
      // An earlier run stuck on a question nobody answered gives way to this one, once.
      if (!retried && (await this.endStaleWait(routine.id, t, STALE_WAIT_MS, 'routine.staleWait')))
        return this.fire(routine, occurrence, payload, true, check);
      // A delivery skipped here must still run when its sender sends it again.
      const skipped = occurrence.startsWith('hook:')
        ? `${occurrence}:busy:${newId().slice(0, 8)}`
        : occurrence;
      return this.record(routine, skipped, 'skipped', t('routine.stillRunning'));
    }
    await this.ctx.db
      .update(schema.routines)
      .set({ lastRunAt: this.clock() })
      .where(eq(schema.routines.id, routine.id));
    const mode = check ? ((await this.services.settings.get('routineGate')) ?? 'off') : 'off';
    const engine = mode !== 'off' ? this.checker?.() : undefined;
    if (check && engine?.gate) {
      const checked = this.checkThenStart(engine, mode === 'on', routine, run, check, () =>
        this.begin(routine, bot.id, thread.id, run, payload, t),
      ).catch((err) => console.error(`Pre-check of routine ${routine.id} failed`, err));
      this.checking.add(checked);
      void checked.finally(() => this.checking.delete(checked));
      return toRun(run);
    }
    await this.begin(routine, bot.id, thread.id, run, payload, t);
    return toRun(run);
  }

  /**
   * Asks the small model whether the run has anything to work on and records its answer. When the
   * check is on, the bot waits for it, and an answer of "nothing new" ends the run as skipped with
   * the reason; a failed check lets the run go ahead. While it only watches, the bot starts at once
   * and the answer is recorded beside the run.
   */
  private async checkThenStart(
    engine: Engine,
    enforce: boolean,
    routine: Routine,
    run: typeof schema.routineRuns.$inferSelect,
    check: { trigger: GateRequest['trigger']; input: string },
    start: () => Promise<void>,
  ) {
    if (!enforce) await start();
    let verdict: GateVerdict | null = null;
    try {
      const report = await this.lastReport(routine.id, run.id);
      verdict = await engine.gate!({
        routine: { name: routine.name, prompt: routine.prompt },
        trigger: check.trigger,
        input: check.input,
        lastReport: report?.text ?? null,
        locale: await this.services.settings.locale(),
        signal: this.stopChecks.signal,
      });
    } catch (err) {
      if (!this.stopChecks.signal.aborted)
        console.warn(`Pre-check of routine ${routine.id} failed, running it: ${(err as Error).message}`);
    }
    const said = verdict
      ? { gateDecision: verdict.decision, gateReason: verdict.reason, gateCostUsd: verdict.costUsd }
      : null;
    if (!enforce) {
      if (said)
        await this.ctx.db.update(schema.routineRuns).set(said).where(eq(schema.routineRuns.id, run.id));
      this.ctx.bus.refresh({ scope: 'routines' });
      return;
    }
    // The server is stopping: the run stays active and ends as cut short when it starts again.
    if (this.stopChecks.signal.aborted) return;
    const skip = verdict?.decision === 'skip';
    const t = await this.services.settings.translator();
    // A run deleted with its routine meanwhile is not started.
    const [still] = await this.ctx.db
      .update(schema.routineRuns)
      .set({
        status: 'running' as const,
        ...said,
        ...(skip
          ? {
              status: 'skipped' as const,
              reason: verdict!.reason
                ? t('routine.gateSkipped', { reason: verdict!.reason })
                : t('routine.gateSkippedNoReason'),
              finishedAt: this.clock(),
            }
          : {}),
      })
      .where(and(eq(schema.routineRuns.id, run.id), eq(schema.routineRuns.status, 'running')))
      .returning({ id: schema.routineRuns.id });
    if (!still) return;
    if (skip) this.ctx.bus.refresh({ scope: 'routines' });
    else await start();
  }

  /** Writes the run's instruction into its conversation and queues the bot's turn for it. */
  private async begin(
    routine: Routine,
    botId: string,
    threadId: string,
    run: typeof schema.routineRuns.$inferSelect,
    payload: string | undefined,
    t: T,
  ) {
    await this.services.threads.addMessage({
      threadId,
      role: 'user',
      author: `routine:${routine.id}`,
      text: payload ? `${routine.prompt}\n\n${t('routine.payloadShown', { payload })}` : routine.prompt,
      props: { routineRunId: run.id, routineName: routine.name, ...(payload ? { payload: true } : {}) },
    });
    const base = t('routine.prompt', { name: routine.name, prompt: routine.prompt, silent: SILENT_REPLY });
    const report = routine.carryReport ? await this.lastReport(routine.id, run.id) : null;
    const prompt = report
      ? `${base}\n\n${t('routine.lastReport', { at: report.at, report: fence(report.text) })}`
      : base;
    await this.services.turns.enqueue({
      threadId,
      botId,
      source: 'routine',
      prompt: payload ? `${prompt}\n\n${t('routine.payload', { payload })}` : prompt,
      routineRunId: run.id,
    });
  }

  /**
   * What the bot wrote at the end of the routine's latest finished run before `except`, cut to a
   * size that keeps every later prompt small; null when no run has finished with a report.
   */
  async lastReport(routineId: string, except?: string): Promise<{ text: string; at: string } | null> {
    const [row] = await this.ctx.db
      .select({ text: schema.messages.text, createdAt: schema.messages.createdAt })
      .from(schema.routineRuns)
      .innerJoin(schema.turns, eq(schema.turns.routineRunId, schema.routineRuns.id))
      .innerJoin(schema.messages, eq(schema.messages.turnId, schema.turns.id))
      .where(
        and(
          eq(schema.routineRuns.routineId, routineId),
          eq(schema.routineRuns.status, 'done'),
          eq(schema.messages.role, 'assistant'),
          except ? ne(schema.routineRuns.id, except) : undefined,
        ),
      )
      .orderBy(desc(schema.routineRuns.startedAt), desc(schema.messages.createdAt))
      .limit(1);
    if (!row?.text.trim()) return null;
    const text = row.text.length > REPORT_MAX ? `${row.text.slice(0, REPORT_MAX)}…` : row.text;
    return { text, at: row.createdAt.toISOString().slice(0, 16).replace('T', ' ') };
  }

  private async record(routine: Routine, occurrence: string, status: 'skipped', reason: string) {
    try {
      const [row] = await this.ctx.db
        .insert(schema.routineRuns)
        .values({
          id: newId(),
          routineId: routine.id,
          occurrence,
          status,
          reason,
          promptSnapshot: routine.prompt,
          finishedAt: this.clock(),
        })
        .returning();
      return toRun(row!);
    } catch (err) {
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  }

  /**
   * The bot says the routine's work is done for good ("remind me until I answer" and the person
   * answered): the routine pauses, and stays as a record the person can turn on again.
   */
  async stopFromRun(runId: string, reason: string): Promise<string | null> {
    const [run] = await this.ctx.db
      .select({ routineId: schema.routineRuns.routineId })
      .from(schema.routineRuns)
      .where(eq(schema.routineRuns.id, runId));
    if (!run) return null;
    const [row] = await this.ctx.db
      .update(schema.routines)
      .set({ enabled: false, nextRunAt: null })
      .where(eq(schema.routines.id, run.routineId))
      .returning();
    await this.ctx.db.update(schema.routineRuns).set({ reason }).where(eq(schema.routineRuns.id, runId));
    this.ctx.bus.refresh({ scope: 'routines' });
    return row?.name ?? null;
  }

  /** The bot says its run could not do the task; the run ends as failed with that reason. */
  async markFailed(runId: string, reason: string) {
    await this.ctx.db
      .update(schema.routineRuns)
      .set({ status: 'error', reason, failedByBot: true })
      .where(eq(schema.routineRuns.id, runId));
    this.ctx.bus.refresh({ scope: 'routines' });
  }

  async onTurnFinished(turn: TurnRow, outcome: TurnOutcome) {
    if (!turn.routineRunId) return;
    const [run] = await this.ctx.db
      .select({ failedByBot: schema.routineRuns.failedByBot })
      .from(schema.routineRuns)
      .where(eq(schema.routineRuns.id, turn.routineRunId));
    await this.ctx.db
      .update(schema.routineRuns)
      .set(
        // A run the bot marked as failed stays failed, with the bot's reason.
        run?.failedByBot && outcome.ok
          ? { finishedAt: this.clock() }
          : {
              status: outcome.ok ? 'done' : 'error',
              reason: outcome.ok ? null : outcome.message,
              finishedAt: this.clock(),
            },
      )
      .where(eq(schema.routineRuns.id, turn.routineRunId));
    // The account was out of usage: the routine tries again once it resets, unless it is due sooner.
    if (!outcome.ok && outcome.kind === 'limit' && outcome.resetsAt) {
      const [run] = await this.ctx.db
        .select({ routineId: schema.routineRuns.routineId })
        .from(schema.routineRuns)
        .where(eq(schema.routineRuns.id, turn.routineRunId));
      const retryAt = new Date(outcome.resetsAt.getTime() + LIMIT_RETRY_DELAY_MS);
      if (run) {
        await this.ctx.db
          .update(schema.routines)
          .set({ nextRunAt: retryAt })
          .where(
            and(
              eq(schema.routines.id, run.routineId),
              eq(schema.routines.enabled, true),
              or(isNull(schema.routines.nextRunAt), gt(schema.routines.nextRunAt, retryAt)),
            ),
          );
      }
    }
    // A passing failure (an overloaded or unreachable provider) is tried once more a little later,
    // unless the run before it failed just now too.
    if (!outcome.ok && outcome.kind === 'engine' && outcome.transient) {
      const [run] = await this.ctx.db
        .select({ routineId: schema.routineRuns.routineId })
        .from(schema.routineRuns)
        .where(eq(schema.routineRuns.id, turn.routineRunId));
      const [before] = run
        ? await this.ctx.db
            .select({ status: schema.routineRuns.status, finishedAt: schema.routineRuns.finishedAt })
            .from(schema.routineRuns)
            .where(
              and(
                eq(schema.routineRuns.routineId, run.routineId),
                ne(schema.routineRuns.id, turn.routineRunId),
              ),
            )
            .orderBy(desc(schema.routineRuns.startedAt))
            .limit(1)
        : [];
      const now = this.clock();
      const retried =
        before?.status === 'error' &&
        !!before.finishedAt &&
        now.getTime() - before.finishedAt.getTime() < RETRY_WINDOW_MS;
      if (run && !retried) {
        const retryAt = new Date(now.getTime() + TRANSIENT_RETRY_DELAY_MS);
        await this.ctx.db
          .update(schema.routines)
          .set({ nextRunAt: retryAt })
          .where(
            and(
              eq(schema.routines.id, run.routineId),
              eq(schema.routines.enabled, true),
              or(isNull(schema.routines.nextRunAt), gt(schema.routines.nextRunAt, retryAt)),
            ),
          );
      }
    }
    this.ctx.bus.refresh({ scope: 'routines' });
  }
}

/** A run waiting this long on a card nobody answered gives way to the routine's next run. */
const STALE_WAIT_MS = 30 * 60_000;
/** A run that failed for a passing reason starts again this long after. */
const TRANSIENT_RETRY_DELAY_MS = 5 * 60_000;
/** A failed run that ended this recently before the failing one means it was already the second try. */
const RETRY_WINDOW_MS = 30 * 60_000;
/** The most of a posted webhook body that goes into the conversation. */
const POST_MAX = 20_000;
/** A slot this late counts as missed while the server was off. */
const MISSED_GRACE_MS = 10 * 60_000;
/** A routine stopped by the usage limit runs again this long after the limit resets. */
const LIMIT_RETRY_DELAY_MS = 2 * 60_000;

/** Compares two secrets in a time that does not tell how much of a guess was right. */
function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
