/** A five-field cron expression (minute hour day-of-month month day-of-week), read into sets. */
export interface Cron {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** Whether day-of-month and day-of-week were both narrowed; then either may match. */
  dayOr: boolean;
  anyDay: boolean;
  anyWeekday: boolean;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function value(raw: string, names: string[] | null, offset: number): number {
  const lower = raw.toLowerCase();
  const named = names ? names.indexOf(lower) : -1;
  if (named >= 0) return named + offset;
  if (!/^\d+$/.test(raw)) throw new Error(raw);
  return Number(raw);
}

function field(
  raw: string,
  min: number,
  max: number,
  names: string[] | null = null,
  offset = 0,
): Set<number> {
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    const [range, stepRaw] = part.split('/') as [string, string | undefined];
    const step = stepRaw === undefined ? 1 : value(stepRaw, null, 0);
    if (step < 1) throw new Error(part);
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = min;
      hi = max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-') as [string, string];
      lo = value(a, names, offset);
      hi = value(b, names, offset);
    } else {
      lo = value(range, names, offset);
      // `5/15` runs from 5 to the end in steps.
      hi = stepRaw === undefined ? lo : max;
    }
    if (lo < min || hi > max || lo > hi) throw new Error(part);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** The expression read into sets, or null when it is not a valid five-field cron expression. */
export function parseCron(expr: string): Cron | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  try {
    const [m, h, dom, mon, dow] = parts as [string, string, string, string, string];
    const weekdays = field(dow, 0, 7, WEEKDAYS);
    // 7 is Sunday too.
    if (weekdays.delete(7)) weekdays.add(0);
    const anyDay = dom === '*';
    const anyWeekday = dow === '*';
    return {
      minutes: field(m, 0, 59),
      hours: field(h, 0, 23),
      days: field(dom, 1, 31),
      months: field(mon, 1, 12, MONTHS, 1),
      weekdays,
      dayOr: !anyDay && !anyWeekday,
      anyDay,
      anyWeekday,
    };
  } catch {
    return null;
  }
}

/** Whether a day passes the expression's day-of-month and day-of-week fields. */
export function cronDay(c: Cron, day: number, weekday: number): boolean {
  if (c.dayOr) return c.days.has(day) || c.weekdays.has(weekday);
  return (c.anyDay || c.days.has(day)) && (c.anyWeekday || c.weekdays.has(weekday));
}
