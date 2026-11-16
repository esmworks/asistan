import { wallClock, zonedTime, type TodayReport, type UsageRange, type UsageReport } from '@yumakbot/shared';
import { and, asc, desc, eq, gte, isNotNull, sql } from 'drizzle-orm';
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

/** What the bots cost and did over a period, read from the finished turns. */
export class UsageService {
  constructor(
    private ctx: Ctx,
    private settings: SettingsService,
    private clock: () => Date = () => new Date(),
  ) {}

  /** Today, from midnight in the owner's time zone: each bot's finished turns, and the routines run. */
  async today(): Promise<TodayReport> {
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
      .where(and(isNotNull(schema.turns.finishedAt), gte(schema.turns.finishedAt, since)));
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
      .where(gte(schema.routineRuns.startedAt, since))
      .orderBy(desc(schema.routineRuns.startedAt));
    return {
      date,
      costUsd,
      bots: [...bots.values()].sort((a, b) => b.turns - a.turns),
      runs: runs.map((r) => ({ ...r, startedAt: r.startedAt.toISOString() })),
    };
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
}
