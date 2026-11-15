import { describe, expect, it } from 'vitest';
import { parseCron } from './cron';
import { describeSchedule, nextRun, Schedule } from './schedule';

const next = (expr: string, tz: string, after: string, last?: string) =>
  nextRun({ type: 'cron', expr }, tz, new Date(after), last ? new Date(last) : null)?.toISOString() ?? null;

describe('cron', () => {
  it('beş alanı okur: liste, aralık, adım ve adlar', () => {
    const c = parseCron('*/15 9-17 * jan-mar mon-fri')!;
    expect([...c.minutes]).toEqual([0, 15, 30, 45]);
    expect(c.hours.size).toBe(9);
    expect([...c.months]).toEqual([1, 2, 3]);
    expect([...c.weekdays]).toEqual([1, 2, 3, 4, 5]);
    expect([...parseCron('0 0 * * 7')!.weekdays]).toEqual([0]);
    expect([...parseCron('5/20 * * * *')!.minutes]).toEqual([5, 25, 45]);
  });

  it('geçersiz ifadeyi reddeder', () => {
    for (const bad of [
      '',
      '* * * *',
      '60 * * * *',
      '* 24 * * *',
      '* * 0 * *',
      '5-1 * * * *',
      '*/0 * * * *',
      'a b c d e',
    ])
      expect(parseCron(bad)).toBeNull();
    expect(Schedule.safeParse({ type: 'cron', expr: '0 9 * * 1-5' }).success).toBe(true);
    expect(Schedule.safeParse({ type: 'cron', expr: '0 9 * *' }).success).toBe(false);
  });

  it('bir sonraki zamanı saat diliminde bulur', () => {
    // Weekdays 09:00 Istanbul; 2026-11-14 is a Saturday.
    expect(next('0 9 * * 1-5', 'Europe/Istanbul', '2026-11-14T10:00:00Z')).toBe('2026-11-16T06:00:00.000Z');
    // Every 15 minutes.
    expect(next('*/15 * * * *', 'UTC', '2026-11-16T10:07:00Z')).toBe('2026-11-16T10:15:00.000Z');
    // The first of a month at noon.
    expect(next('0 12 1 * *', 'UTC', '2026-11-16T10:00:00Z')).toBe('2026-12-01T12:00:00.000Z');
    // Day-of-month and weekday both narrowed: either matches (the 13th or any Friday).
    expect(next('0 0 13 * 5', 'UTC', '2026-11-16T00:00:00Z')).toBe('2026-11-20T00:00:00.000Z');
    // February 29th waits for a leap year.
    expect(next('0 0 29 2 *', 'UTC', '2026-11-16T00:00:00Z')).toBeNull();
  });

  it('adıyla okunur', () => {
    expect(describeSchedule({ type: 'cron', expr: '0 9 * * 1-5' }, 'en')).toBe('Cron: 0 9 * * 1-5');
  });
});
