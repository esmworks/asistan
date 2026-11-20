import {
  PlanWindow,
  wallClock,
  zonedTime,
  type TodayReport,
  type UsageRange,
  type UsageReport,
} from '@yumakbot/shared';
import { z } from 'zod';
import { and, asc, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import type { SettingsService } from './settings';

const pad = (n: number) => String(n).padStart(2, '0');
/** A calendar day in the given time zone, as YYYY-MM-DD. */
export function dayKey(date: Date, tz: string): string {
  const w = wallClock(date, tz);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

/** The last `days` calendar days in the time zone, oldest first, today last. */
export function lastDays(now: Date, days: number, tz: string): string[] {
  const keys: string[] = [];
  // Half-day steps never skip a day, even across a daylight saving change.
  for (let at = now.getTime(); keys.length < days; at -= 12 * 3_600_000) {
    const k = dayKey(new Date(at), tz);
    if (keys.at(-1) !== k) keys.push(k);
  }
  return keys.reverse();
}

/** The first moment of the calendar month `now` is in, in the time zone. */
export function monthStart(now: Date, tz: string): Date {
  const w = wallClock(now, tz);
  return zonedTime(`${w.year}-${pad(w.month)}-01`, '00:00', tz);
}

/** A value for one CSV cell: quoted when it holds a comma, quote or line break. */
export function csvCell(v: string | number | null): string {
  const s = v === null ? '' : String(v);
  // A leading = + - @ would run as a formula in a spreadsheet.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

const PLAN_KEY = 'usage.plan';
const StoredPlan = z.object({ at: z.string(), windows: z.array(PlanWindow) });

/** What the bots cost and did over a period, read from the finished turns. */
export class UsageService {
  constructor(
    private ctx: Ctx,
    private settings: SettingsService,
    private clock: () => Date = () => new Date(),
  ) {}

  /** Today, from midnight in the owner's time zone: each bot's finished turns, and the routines run. */
  /** Today's work; with `botIds`, only those bots'. */
  async today(botIds?: string[]): Promise<TodayReport> {
    const { timezone } = await this.settings.all();
    const now = this.clock();
    const date = dayKey(now, timezone);
    const since = zonedTime(date, '00:00', timezone);
    const turns = await this.ctx.db
      .select({
        botId: schema.turns.botId,
        name: schema.bots.name,
        status: schema.turns.status,
        costUsd: schema.turns.costUsd,
      })
      .from(schema.turns)
      .innerJoin(schema.bots, eq(schema.bots.id, schema.turns.botId))
      .where(
        and(
          isNotNull(schema.turns.finishedAt),
          gte(schema.turns.finishedAt, since),
          botIds && (botIds.length ? inArray(schema.turns.botId, botIds) : sql`false`),
        ),
      );
    const bots = new Map<string, TodayReport['bots'][number]>();
    let costUsd = 0;
    for (const r of turns) {
      const b = bots.get(r.botId) ?? { botId: r.botId, name: r.name, turns: 0, failed: 0, costUsd: 0 };
      b.turns++;
      if (r.status === 'error') b.failed++;
      b.costUsd += r.costUsd ?? 0;
      costUsd += r.costUsd ?? 0;
      bots.set(r.botId, b);
    }
    const runs = await this.ctx.db
      .select({
        routineId: schema.routineRuns.routineId,
        name: schema.routines.name,
        botId: schema.routines.botId,
        status: schema.routineRuns.status,
        threadId: schema.routineRuns.threadId,
        startedAt: schema.routineRuns.startedAt,
      })
      .from(schema.routineRuns)
      .innerJoin(schema.routines, eq(schema.routines.id, schema.routineRuns.routineId))
      .where(
        and(
          gte(schema.routineRuns.startedAt, since),
          botIds && (botIds.length ? inArray(schema.routines.botId, botIds) : sql`false`),
        ),
      )
      .orderBy(desc(schema.routineRuns.startedAt));
    return {
      date,
      costUsd,
      bots: [...bots.values()].sort((a, b) => b.turns - a.turns),
      runs: runs.map((r) => ({ ...r, startedAt: r.startedAt.toISOString() })),
    };
  }

  /** Plan windows being kept, one after another, so two turns ending together both count. */
  private planWrites: Promise<void> = Promise.resolve();

  /**
   * Keeps the plan's usage windows a Claude turn saw, each by its kind: a turn that heard of one
   * window leaves the others as they were.
   */
  notePlan(windows: PlanWindow[]): Promise<void> {
    const write = this.planWrites.then(() => this.writePlan(windows));
    this.planWrites = write.catch(() => {});
    return write;
  }

  private async writePlan(windows: PlanWindow[]) {
    const now = this.clock().toISOString();
    const before = await this.plan(false);
    const byKind = new Map((before?.windows ?? []).map((w) => [w.kind, w]));
    for (const w of windows) byKind.set(w.kind, PlanWindow.parse(w));
    const value = { at: now, windows: [...byKind.values()].slice(0, 12) };
    await this.ctx.db
      .insert(schema.kv)
      .values({ key: PLAN_KEY, value })
      .onConflictDoUpdate({ target: schema.kv.key, set: { value } });
    // The chat's plan meter shows what is left as it changes.
    this.ctx.bus.refresh({ scope: 'plan' });
  }

  /**
   * The plan's usage windows last seen. With `current`, a window whose reset has passed is left
   * out: what it said is no longer true.
   */
  async plan(current = true): Promise<UsageReport['plan']> {
    const [row] = await this.ctx.db.select().from(schema.kv).where(eq(schema.kv.key, PLAN_KEY)).limit(1);
    const parsed = StoredPlan.safeParse(row?.value);
    if (!parsed.success) return undefined;
    const now = this.clock().getTime();
    const windows = current
      ? parsed.data.windows.filter((w) => !w.resetsAt || Date.parse(w.resetsAt) > now)
      : parsed.data.windows;
    return windows.length || !current ? { at: parsed.data.at, windows } : undefined;
  }

  /** Spending since the start of this calendar month, and the limit set for it (0: none). */
  async month(): Promise<{ costUsd: number; limitUsd: number }> {
    const { timezone, monthlyLimitUsd } = await this.settings.all();
    const rows = await this.ctx.db
      .select({ costUsd: schema.turns.costUsd })
      .from(schema.turns)
      .where(
        and(
          isNotNull(schema.turns.finishedAt),
          gte(schema.turns.finishedAt, monthStart(this.clock(), timezone)),
        ),
      );
    return { costUsd: rows.reduce((sum, r) => sum + (r.costUsd ?? 0), 0), limitUsd: monthlyLimitUsd };
  }

  /** Every finished turn of the last `days` days as CSV, one row each, oldest first. */
  async csv(days: UsageRange): Promise<string> {
    const since = new Date(this.clock().getTime() - days * 86_400_000);
    const rows = await this.ctx.db
      .select({
        finishedAt: schema.turns.finishedAt,
        bot: schema.bots.name,
        source: schema.turns.source,
        status: schema.turns.status,
        engine: schema.turns.engine,
        model: schema.turns.model,
        costUsd: schema.turns.costUsd,
      })
      .from(schema.turns)
      .innerJoin(schema.bots, eq(schema.bots.id, schema.turns.botId))
      .where(and(isNotNull(schema.turns.finishedAt), gte(schema.turns.finishedAt, since)))
      .orderBy(asc(schema.turns.finishedAt));
    const lines = [['finished_at', 'bot', 'source', 'status', 'engine', 'model', 'cost_usd'].join(',')];
    for (const r of rows) {
      lines.push(
        [r.finishedAt!.toISOString(), r.bot, r.source, r.status, r.engine, r.model, r.costUsd]
          .map((v) => csvCell(v ?? null))
          .join(','),
      );
    }
    return `${lines.join('\n')}\n`;
  }

  /** With `botId`, only that bot's turns. */
  async report(days: UsageRange, botId?: string): Promise<UsageReport> {
    const timezone = (await this.settings.all()).timezone;
    const now = this.clock();
    const keys = lastDays(now, days, timezone);
    // A day and a half more than asked: the first local day starts somewhere in there.
    const since = new Date(now.getTime() - (days + 1.5) * 86_400_000);
    const rows = await this.ctx.db
      .select({
        botId: schema.turns.botId,
        costUsd: schema.turns.costUsd,
        finishedAt: schema.turns.finishedAt,
        engine: schema.turns.engine,
        model: schema.turns.model,
        routineId: schema.routineRuns.routineId,
        routineName: schema.routines.name,
      })
      .from(schema.turns)
      .leftJoin(schema.routineRuns, eq(schema.routineRuns.id, schema.turns.routineRunId))
      .leftJoin(schema.routines, eq(schema.routines.id, schema.routineRuns.routineId))
      .where(
        and(
          isNotNull(schema.turns.finishedAt),
          gte(schema.turns.finishedAt, since),
          botId ? eq(schema.turns.botId, botId) : undefined,
        ),
      );
    const bots = await this.ctx.db
      .select({ id: schema.bots.id, name: schema.bots.name, archivedAt: schema.bots.archivedAt })
      .from(schema.bots);
    const byId = new Map(bots.map((b) => [b.id, b]));

    const empty = () => ({ costUsd: 0, turns: 0, unpriced: 0 });
    const total = empty();
    const perBot = new Map<string, ReturnType<typeof empty>>();
    const perModel = new Map<
      string,
      ReturnType<typeof empty> & Pick<(typeof rows)[number], 'engine' | 'model'>
    >();
    const perRoutine = new Map<string, ReturnType<typeof empty> & { name: string; botId: string }>();
    const perDay = new Map(keys.map((k) => [k, { costUsd: 0, turns: 0 }]));
    for (const r of rows) {
      const day = perDay.get(dayKey(r.finishedAt!, timezone));
      if (!day) continue;
      const bot = perBot.get(r.botId) ?? empty();
      perBot.set(r.botId, bot);
      const modelKey = `${r.engine ?? ''}\u0000${r.model ?? ''}`;
      const model = perModel.get(modelKey) ?? { ...empty(), engine: r.engine, model: r.model };
      perModel.set(modelKey, model);
      // A routine deleted since keeps no name; its runs still count in the totals above.
      const routine =
        r.routineId && r.routineName
          ? (perRoutine.get(r.routineId) ?? { ...empty(), name: r.routineName, botId: r.botId })
          : null;
      if (routine) perRoutine.set(r.routineId!, routine);
      for (const sum of [total, bot, model, ...(routine ? [routine] : [])]) {
        sum.turns++;
        if (r.costUsd === null) sum.unpriced++;
        else sum.costUsd += r.costUsd;
      }
      day.turns++;
      day.costUsd += r.costUsd ?? 0;
    }
    return {
      days,
      timezone,
      month: await this.month(),
      plan: await this.plan(),
      parallel: {
        max: (await this.settings.get('maxTurns')) ?? 0,
        serverDefault: this.ctx.config.maxConcurrentTurns,
      },
      total,
      bots: [...perBot.entries()]
        .map(([botId, sum]) => ({
          botId,
          name: byId.get(botId)?.name ?? '',
          archived: !!byId.get(botId)?.archivedAt,
          ...sum,
        }))
        .sort((a, b) => b.costUsd - a.costUsd || b.turns - a.turns),
      models: [...perModel.values()].sort((a, b) => b.costUsd - a.costUsd || b.turns - a.turns),
      routines: [...perRoutine.entries()]
        .map(([routineId, sum]) => ({ routineId, ...sum }))
        .sort((a, b) => b.costUsd - a.costUsd || b.turns - a.turns),
      daily: keys.map((date) => ({ date, ...perDay.get(date)! })),
      gate: await this.gate(since, new Set(keys), timezone, botId),
      promises: await this.promiseNet(since, new Set(keys), timezone, botId),
      suggestions: await this.suggestionNet(since, new Set(keys), timezone, botId),
    };
  }

  /**
   * The routine pre-check over the period: the runs it looked at and what that cost, the runs it
   * would have skipped while only watching with what their turns cost, and the runs it skipped.
   * Undefined when it looked at none.
   */
  private async gate(
    since: Date,
    days: Set<string>,
    timezone: string,
    botId?: string,
  ): Promise<UsageReport['gate']> {
    const rows = await this.ctx.db
      .select({
        startedAt: schema.routineRuns.startedAt,
        decision: schema.routineRuns.gateDecision,
        costUsd: schema.routineRuns.gateCostUsd,
        status: schema.routineRuns.status,
        turnCostUsd: sql<
          number | null
        >`(select sum(${schema.turns.costUsd}) from ${schema.turns} where ${schema.turns.routineRunId} = ${schema.routineRuns.id})`,
      })
      .from(schema.routineRuns)
      .innerJoin(schema.routines, eq(schema.routines.id, schema.routineRuns.routineId))
      .where(
        and(
          isNotNull(schema.routineRuns.gateDecision),
          gte(schema.routineRuns.startedAt, since),
          botId ? eq(schema.routines.botId, botId) : undefined,
        ),
      );
    const sum = { checks: 0, costUsd: 0, skippable: 0, skippableCostUsd: 0, skipped: 0 };
    for (const r of rows) {
      if (!days.has(dayKey(r.startedAt, timezone))) continue;
      sum.checks++;
      sum.costUsd += r.costUsd ?? 0;
      if (r.decision !== 'skip') continue;
      if (r.status === 'skipped') sum.skipped++;
      else {
        sum.skippable++;
        sum.skippableCostUsd += Number(r.turnCostUsd ?? 0);
      }
    }
    return sum.checks ? sum : undefined;
  }

  /** The promise safety net over the period: its looks at replies, what they cost and the promises found. */
  private async promiseNet(
    since: Date,
    days: Set<string>,
    timezone: string,
    botId?: string,
  ): Promise<UsageReport['promises']> {
    const rows = await this.ctx.db
      .select({
        at: schema.promiseChecks.createdAt,
        costUsd: schema.promiseChecks.costUsd,
        found: schema.promiseChecks.found,
      })
      .from(schema.promiseChecks)
      .where(
        and(
          gte(schema.promiseChecks.createdAt, since),
          botId ? eq(schema.promiseChecks.botId, botId) : undefined,
        ),
      );
    const sum = { checks: 0, costUsd: 0, found: 0 };
    for (const r of rows) {
      if (!days.has(dayKey(r.at, timezone))) continue;
      sum.checks++;
      sum.costUsd += r.costUsd ?? 0;
      if (r.found) sum.found++;
    }
    return sum.checks ? sum : undefined;
  }

  /** The routine suggestions over the period: its calls to the small model, what they cost and the suggestions made. */
  private async suggestionNet(
    since: Date,
    days: Set<string>,
    timezone: string,
    botId?: string,
  ): Promise<UsageReport['suggestions']> {
    const rows = await this.ctx.db
      .select({
        at: schema.routineSuggestionChecks.createdAt,
        costUsd: schema.routineSuggestionChecks.costUsd,
        found: schema.routineSuggestionChecks.found,
      })
      .from(schema.routineSuggestionChecks)
      .where(
        and(
          gte(schema.routineSuggestionChecks.createdAt, since),
          botId ? eq(schema.routineSuggestionChecks.botId, botId) : undefined,
        ),
      );
    const sum = { checks: 0, costUsd: 0, found: 0 };
    for (const r of rows) {
      if (!days.has(dayKey(r.at, timezone))) continue;
      sum.checks++;
      sum.costUsd += r.costUsd ?? 0;
      if (r.found) sum.found++;
    }
    return sum.checks ? sum : undefined;
  }
}
