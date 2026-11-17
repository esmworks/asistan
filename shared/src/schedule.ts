import { z } from 'zod';
import { createTranslator, DEFAULT_LOCALE, INTL_LOCALE, type Catalog, type Locale } from './i18n';
import { cronDay, parseCron } from './cron';
import { patchOf } from './patch';

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'validation.time');

export const Schedule = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hourly'), minute: z.number().int().min(0).max(59) }),
  z.object({ type: z.literal('daily'), time }),
  z.object({ type: z.literal('weekdays'), time }),
  z.object({
    type: z.literal('weekly'),
    /** 0 = Sunday ... 6 = Saturday */
    days: z.array(z.number().int().min(0).max(6)).min(1),
    time,
  }),
  z.object({ type: z.literal('monthly'), day: z.number().int().min(1).max(31), time }),
  z
    .object({
      type: z.literal('interval'),
      minutes: z
        .number()
        .int()
        .min(5)
        .max(7 * 24 * 60),
      /** Only on these weekdays (0 = Sunday); every day when left out. */
      days: z.array(z.number().int().min(0).max(6)).min(1).optional(),
      /** Only between these local times, both included; all day when left out. */
      from: time.optional(),
      to: time.optional(),
    })
    .refine((s) => !s.from === !s.to && (!s.from || s.from < s.to!), 'validation.timeWindow'),
  /** A five-field cron expression (`0 9 * * 1-5`), read in the routine's time zone. */
  z.object({
    type: z.literal('cron'),
    expr: z
      .string()
      .trim()
      .max(120)
      .refine((e) => parseCron(e) !== null, 'validation.cron'),
  }),
  /** One run at a local date and time; the routine turns itself off after it. */
  z.object({
    type: z.literal('once'),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'validation.date'),
    time,
  }),
]);
export type Schedule = z.infer<typeof Schedule>;

/**
 * A connected app's read-only tool called before each scheduled run, with no AI: the bot runs only
 * when the tool's answer differs from the last check (a new email, a new issue), and gets that
 * answer. A quiet tick then costs nothing.
 */
export const RoutineCheck = z.object({
  connectionId: z.string().min(1).max(64),
  /** The tool's own name on the app's server. */
  tool: z.string().min(1).max(200),
  args: z.record(z.string(), z.unknown()).default({}),
});
export type RoutineCheck = z.infer<typeof RoutineCheck>;

export const Routine = z.object({
  id: z.string(),
  botId: z.string(),
  name: z.string(),
  prompt: z.string(),
  schedule: Schedule,
  timezone: z.string(),
  enabled: z.boolean(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  createdAt: z.string(),
  missed: z.enum(['run', 'skip']),
  /** Each run is given the previous run's report to build on. */
  carryReport: z.boolean(),
  /** Runs in the bot's main conversation instead of one of its own. */
  inMain: z.boolean(),
  /** Also runs once each time the server starts. */
  onStartup: z.boolean(),
  /** A page checked before each scheduled run, without the AI; the bot runs only when it changed. */
  watchUrl: z.string().nullable(),
  /** A connected app's tool checked before each scheduled run; the bot runs only when its answer changed. */
  check: RoutineCheck.nullable(),
  /** Conditions a webhook call's JSON body must meet to start the routine, one per line. */
  webhookFilter: z.string(),
  /** A webhook call only posts what it carries, as the bot's message, with no AI turn. */
  webhookPost: z.boolean(),
  /** The model its runs use, on the bot's own engine; empty for the bot's model. */
  model: z.string(),
  /** Also runs when mail arrives at the bot's address. */
  emailTrigger: z.boolean(),
  /** Conditions a mail must meet to start it, one per line, on from, to, subject and text. */
  emailFilter: z.string(),
  /**
   * The secret part of the address that starts the routine from another service (a webhook);
   * null when it has none.
   */
  webhookToken: z.string().nullable(),
});
export type Routine = z.infer<typeof Routine>;

export const RoutineCreate = z.object({
  botId: z.string(),
  name: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(20_000),
  schedule: Schedule,
  timezone: z.string().refine(isValidTimeZone, 'validation.timezone').default('Europe/Istanbul'),
  enabled: z.boolean().default(true),
  /**
   * What happens to a run that came due while the server was off: `run` runs it once when the
   * server is back, `skip` drops it and waits for the next one.
   */
  missed: z.enum(['run', 'skip']).default('run'),
  /** Each run is given the previous finished run's report, so it can say what changed since. */
  carryReport: z.boolean().default(false),
  /**
   * Runs in the bot's main conversation, where the person talks to it and with what was said there,
   * instead of a conversation of its own.
   */
  inMain: z.boolean().default(false),
  /** Also runs once each time the server starts: on a desktop, when the computer is turned on. */
  onStartup: z.boolean().default(false),
  /**
   * An https page read before each scheduled run, with no AI: the bot runs only when the page's
   * text changed since the last read, and gets the new text. Null for none.
   */
  watchUrl: z
    .string()
    .trim()
    .max(2000)
    .regex(/^https:\/\/\S+$/, 'validation.watchUrl')
    .nullable()
    .default(null),
  check: RoutineCheck.nullable().default(null),
  /** `field=value`, `field!=value` or `field` lines; a webhook call must meet all of them. */
  webhookFilter: z.string().max(2000).default(''),
  webhookPost: z.boolean().default(false),
  model: z.string().trim().max(200).default(''),
  emailTrigger: z.boolean().default(false),
  emailFilter: z.string().max(2000).default(''),
});
export type RoutineCreate = z.infer<typeof RoutineCreate>;
export const RoutineUpdate = patchOf(RoutineCreate.omit({ botId: true }));

/**
 * The pre-check before a routine run that a watched page change or a webhook started: `off` runs
 * every time, `shadow` asks a small model and only records what it said, `on` skips the runs it
 * says have nothing new to work on.
 */
export const ROUTINE_GATE_MODES = ['off', 'shadow', 'on'] as const;
export type RoutineGateMode = (typeof ROUTINE_GATE_MODES)[number];
export const RoutineGateDecision = z.enum(['run', 'skip']);

export const RoutineRunStatus = z.enum(['running', 'done', 'error', 'skipped', 'waiting']);
export const RoutineRun = z.object({
  id: z.string(),
  routineId: z.string(),
  occurrence: z.string(),
  status: RoutineRunStatus,
  reason: z.string().nullable(),
  threadId: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  /**
   * What the small model said before the run, when the routine pre-check looked at it: `skip` means
   * the run looked like it had nothing new to work on. Null when no pre-check ran.
   */
  gate: z.object({ decision: RoutineGateDecision, reason: z.string() }).nullable(),
});
export type RoutineRun = z.infer<typeof RoutineRun>;

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    });
    formatters.set(tz, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function wallClock(date: Date, tz: string): WallClock {
  const parts: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(date)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday ?? 'Sun'] ?? 0,
  };
}

function parseTime(t: string): [number, number] {
  const [h, m] = t.split(':').map(Number);
  return [h ?? 0, m ?? 0];
}

function matches(s: Schedule, w: WallClock): boolean {
  switch (s.type) {
    case 'hourly':
      return w.minute === s.minute;
    case 'daily': {
      const [h, m] = parseTime(s.time);
      return w.hour === h && w.minute === m;
    }
    case 'weekdays': {
      const [h, m] = parseTime(s.time);
      return w.weekday >= 1 && w.weekday <= 5 && w.hour === h && w.minute === m;
    }
    case 'weekly': {
      const [h, m] = parseTime(s.time);
      return s.days.includes(w.weekday) && w.hour === h && w.minute === m;
    }
    case 'monthly': {
      const [h, m] = parseTime(s.time);
      return w.day === s.day && w.hour === h && w.minute === m;
    }
    case 'interval':
    case 'once':
    case 'cron':
      return false;
  }
}

/** The moment a local date and time in `tz` happens, as a UTC Date. */
export function zonedTime(date: string, time: string, tz: string): Date {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi] = parseTime(time);
  const wanted = Date.UTC(y, mo - 1, d, h, mi);
  // Start from the wall time read as UTC and correct by the zone's offset; twice covers a change.
  let at = wanted;
  for (let i = 0; i < 2; i++) {
    const w = wallClock(new Date(at), tz);
    at += wanted - Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  }
  return new Date(at);
}

const MINUTE = 60_000;

/**
 * Next run strictly after `after`, as a minute-aligned UTC Date.
 * For `interval`, runs are spaced from `lastRun` (or start one interval after `after`).
 * Returns null if nothing matches within ~62 days (e.g. monthly day 31 never appears).
 */
export function nextRun(s: Schedule, tz: string, after: Date, lastRun?: Date | null): Date | null {
  if (s.type === 'once') {
    const at = zonedTime(s.date, s.time, tz);
    // Its one slot: due until it has run, even when it went by while the server was off.
    return lastRun && lastRun.getTime() >= at.getTime() ? null : at;
  }
  if (s.type === 'interval') {
    const base = lastRun ?? after;
    let next = Math.floor(base.getTime() / MINUTE) * MINUTE + s.minutes * MINUTE;
    if (next <= after.getTime()) {
      const missed = Math.ceil((after.getTime() - next) / (s.minutes * MINUTE));
      next += missed * s.minutes * MINUTE;
      if (next <= after.getTime()) next += s.minutes * MINUTE;
    }
    return intoWindow(s, tz, new Date(next));
  }
  if (s.type === 'cron') return nextCron(s.expr, tz, after, lastRun);
  let t = Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE;
  const limit = t + 62 * 24 * 60 * MINUTE;
  // Fast path: jump hour by hour while the hour cannot match (all schedules except hourly fix the hour).
  // When clocks fall back, the same wall time happens twice; run it only once.
  const last = lastRun ? wallClock(lastRun, tz) : null;
  const sameAsLast = (w: WallClock) =>
    !!last &&
    w.year === last.year &&
    w.month === last.month &&
    w.day === last.day &&
    w.hour === last.hour &&
    w.minute === last.minute;
  while (t < limit) {
    const w = wallClock(new Date(t), tz);
    if (matches(s, w) && !sameAsLast(w)) return new Date(t);
    if (s.type !== 'hourly') {
      const [h] = parseTime(s.time);
      if (w.hour !== h) {
        t += (60 - w.minute) * MINUTE;
        continue;
      }
    }
    t += MINUTE;
  }
  return null;
}

/**
 * The next minute after `after` a cron expression names in `tz`, looking up to a year and a bit
 * ahead. Whole months, days and hours that cannot match are skipped at once.
 */
function nextCron(expr: string, tz: string, after: Date, lastRun?: Date | null): Date | null {
  const c = parseCron(expr);
  if (!c) return null;
  const last = lastRun ? wallClock(lastRun, tz) : null;
  let t = Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE;
  const limit = t + 370 * 24 * 60 * MINUTE;
  while (t < limit) {
    const w = wallClock(new Date(t), tz);
    if (!c.months.has(w.month)) {
      const next = new Date(Date.UTC(w.year, w.month, 1)).toISOString().slice(0, 10);
      t = Math.max(t + MINUTE, zonedTime(next, '00:00', tz).getTime());
      continue;
    }
    if (!cronDay(c, w.day, w.weekday)) {
      t = Math.max(t + MINUTE, zonedTime(dayAfter(w, 1), '00:00', tz).getTime());
      continue;
    }
    if (!c.hours.has(w.hour)) {
      t += (60 - w.minute) * MINUTE;
      continue;
    }
    const repeat =
      !!last &&
      last.year === w.year &&
      last.month === w.month &&
      last.day === w.day &&
      last.hour === w.hour &&
      last.minute === w.minute;
    if (c.minutes.has(w.minute) && !repeat) return new Date(t);
    t += MINUTE;
  }
  return null;
}

type IntervalSchedule = Extract<Schedule, { type: 'interval' }>;

/** The local date `days` after a wall clock's date, as YYYY-MM-DD. */
function dayAfter(w: WallClock, days: number): string {
  return new Date(Date.UTC(w.year, w.month - 1, w.day + days)).toISOString().slice(0, 10);
}

/**
 * The first moment at or after `at` that an interval routine's days and hours allow. The runs
 * that follow are spaced from it, so each allowed stretch starts at its first minute.
 */
function intoWindow(s: IntervalSchedule, tz: string, at: Date): Date {
  if (!s.days && !s.from) return at;
  const [fromH, fromM] = s.from ? parseTime(s.from) : [0, 0];
  const [toH, toM] = s.to ? parseTime(s.to) : [23, 59];
  const start = fromH * 60 + fromM;
  const end = toH * 60 + toM;
  let t = at;
  // A week ahead always holds an allowed day; one step per day at most.
  for (let i = 0; i < 9; i++) {
    const w = wallClock(t, tz);
    const minute = w.hour * 60 + w.minute;
    const dayOk = !s.days || s.days.includes(w.weekday);
    if (dayOk && minute >= start && minute <= end) return t;
    const startOf = (days: number) => zonedTime(dayAfter(w, days), s.from ?? '00:00', tz);
    t = dayOk && minute < start ? startOf(0) : startOf(1);
  }
  return t;
}

/** Stable key for one scheduled occurrence, so the same slot never runs twice. */
export function occurrenceKey(at: Date): string {
  return new Date(Math.floor(at.getTime() / MINUTE) * MINUTE).toISOString();
}

const DAY_NAMES: Record<Locale, string[]> = {
  tr: ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'],
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
};

/** Short weekday names, Sunday first (index = `Schedule` weekday number). */
export const SHORT_DAY_NAMES: Record<Locale, string[]> = {
  tr: ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'],
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
};

const SCHEDULE_TEXT: Record<Locale, Catalog> = {
  tr: {
    hourly: 'Her saat :{minute}',
    daily: 'Her gün {time}',
    weekdays: 'Hafta içi {time}',
    weekly: '{days} {time}',
    monthly: 'Her ayın {day}. günü {time}',
    once: '{date} {time} (bir kez)',
    hours: '{count} saatte bir',
    minutes: '{count} dakikada bir',
    between: '{from}–{to} arası',
    cron: 'Cron: {expr}',
  },
  en: {
    hourly: 'Every hour at :{minute}',
    daily: 'Every day at {time}',
    weekdays: 'Weekdays at {time}',
    weekly: '{days} at {time}',
    monthly: 'Monthly on day {day} at {time}',
    once: 'Once, on {date} at {time}',
    hours: { one: 'Every hour', other: 'Every {count} hours' },
    minutes: { one: 'Every minute', other: 'Every {count} minutes' },
    between: 'between {from} and {to}',
    cron: 'Cron: {expr}',
  },
};

export function describeSchedule(s: Schedule, locale: Locale = DEFAULT_LOCALE): string {
  const t = createTranslator(SCHEDULE_TEXT, locale);
  switch (s.type) {
    case 'hourly':
      return t('hourly', { minute: String(s.minute).padStart(2, '0') });
    case 'daily':
    case 'weekdays':
      return t(s.type, { time: s.time });
    case 'weekly': {
      const days = [...s.days].sort().map((d) => DAY_NAMES[locale][d]);
      return t('weekly', { days: days.join(', '), time: s.time });
    }
    case 'monthly':
      return t('monthly', { day: s.day, time: s.time });
    case 'interval': {
      const every =
        s.minutes % 60 === 0 ? t('hours', { count: s.minutes / 60 }) : t('minutes', { count: s.minutes });
      const parts = [every];
      if (s.days)
        parts.push(
          [...s.days]
            .sort()
            .map((d) => SHORT_DAY_NAMES[locale][d])
            .join(', '),
        );
      if (s.from && s.to) parts.push(t('between', { from: s.from, to: s.to }));
      return parts.join(', ');
    }
    case 'cron':
      return t('cron', { expr: s.expr });
    case 'once': {
      const [y, m, d] = s.date.split('-').map(Number) as [number, number, number];
      const date = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(INTL_LOCALE[locale], {
        timeZone: 'UTC',
        dateStyle: 'medium',
      });
      return t('once', { date, time: s.time });
    }
  }
}
