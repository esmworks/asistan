import { describe, expect, it } from 'vitest';
import { BotCreate, BotUpdate } from './schemas';
import { describeSchedule, nextRun, occurrenceKey, RoutineUpdate, Schedule, zonedTime } from './schedule';

const at = (iso: string) => new Date(iso);
const next = (s: Schedule, tz: string, after: string, last?: string) =>
  nextRun(s, tz, at(after), last ? at(last) : null)?.toISOString() ?? null;

describe('nextRun', () => {
  it('günlük, saat dilimine göre', () => {
    // Istanbul is UTC+3 all year.
    expect(next({ type: 'daily', time: '09:00' }, 'Europe/Istanbul', '2026-11-16T05:30:00Z')).toBe(
      '2026-11-16T06:00:00.000Z',
    );
    expect(next({ type: 'daily', time: '09:00' }, 'Europe/Istanbul', '2026-11-16T06:00:00Z')).toBe(
      '2026-11-17T06:00:00.000Z',
    );
  });

  it('hafta içi cumartesi ve pazarı atlar', () => {
    // 2026-11-20 is a Friday.
    expect(next({ type: 'weekdays', time: '08:00' }, 'UTC', '2026-11-20T09:00:00Z')).toBe(
      '2026-11-23T08:00:00.000Z',
    );
  });

  it('haftalık, seçili günler', () => {
    expect(next({ type: 'weekly', days: [3, 5], time: '18:30' }, 'UTC', '2026-11-16T00:00:00Z')).toBe(
      '2026-11-18T18:30:00.000Z',
    );
  });

  it('aylık 31: o günü olmayan ayları atlar', () => {
    expect(next({ type: 'monthly', day: 31, time: '10:00' }, 'UTC', '2026-11-01T00:00:00Z')).toBe(
      '2026-12-31T10:00:00.000Z',
    );
  });

  it('saatlik', () => {
    expect(next({ type: 'hourly', minute: 15 }, 'Asia/Kolkata', '2026-11-16T10:00:00Z')).toBe(
      '2026-11-16T10:45:00.000Z',
    );
  });

  it('aralık: son çalıştırmaya göre, kaçırılanları tek seferde atlar', () => {
    const s: Schedule = { type: 'interval', minutes: 30 };
    expect(next(s, 'UTC', '2026-11-16T10:05:00Z', '2026-11-16T10:00:00Z')).toBe('2026-11-16T10:30:00.000Z');
    expect(next(s, 'UTC', '2026-11-16T13:10:00Z', '2026-11-16T10:00:00Z')).toBe('2026-11-16T13:30:00.000Z');
  });

  it('aralık günler ve saatlerle sınırlanabilir; dışarıda kalan çalışma bir sonraki izinli başa kayar', () => {
    // 2026-11-16 is a Monday. Weekdays, 09:00–18:00 Istanbul (UTC+3).
    const s: Schedule = { type: 'interval', minutes: 60, days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' };
    const tz = 'Europe/Istanbul';
    // Inside the window: an hour after the last run.
    expect(next(s, tz, '2026-11-16T08:05:00Z', '2026-11-16T08:00:00Z')).toBe('2026-11-16T09:00:00.000Z');
    // 18:00 is the last run of the day; the next is 09:00 tomorrow.
    expect(next(s, tz, '2026-11-16T15:00:00Z', '2026-11-16T15:00:00Z')).toBe('2026-11-17T06:00:00.000Z');
    // Before the window opens: at its start.
    expect(next(s, tz, '2026-11-16T03:00:00Z')).toBe('2026-11-16T06:00:00.000Z');
    // Friday evening: Monday morning.
    expect(next(s, tz, '2026-11-20T16:00:00Z', '2026-11-20T15:00:00Z')).toBe('2026-11-23T06:00:00.000Z');
    // Days alone, all day long.
    const weekend: Schedule = { type: 'interval', minutes: 30, days: [0, 6] };
    expect(next(weekend, 'UTC', '2026-11-20T10:05:00Z', '2026-11-20T10:00:00Z')).toBe(
      '2026-11-21T00:00:00.000Z',
    );
    expect(next(weekend, 'UTC', '2026-11-21T00:05:00Z', '2026-11-21T00:00:00Z')).toBe(
      '2026-11-21T00:30:00.000Z',
    );
  });

  it('saat aralığının iki ucu birlikte ve sıralı olmalı', () => {
    expect(Schedule.safeParse({ type: 'interval', minutes: 30, from: '09:00' }).success).toBe(false);
    expect(Schedule.safeParse({ type: 'interval', minutes: 30, from: '18:00', to: '09:00' }).success).toBe(
      false,
    );
    expect(Schedule.safeParse({ type: 'interval', minutes: 30, from: '09:00', to: '18:00' }).success).toBe(
      true,
    );
    expect(
      describeSchedule({ type: 'interval', minutes: 30, days: [5, 1], from: '09:00', to: '18:00' }, 'en'),
    ).toBe('Every 30 minutes, Mon, Fri, between 09:00 and 18:00');
  });

  it('yaz saati: ileri alınan günde kaybolan saat bir sonraki güne kayar, geri alınan saat bir kez çalışır', () => {
    // US spring forward: 2026-03-08 02:00 -> 03:00 in New York.
    expect(next({ type: 'daily', time: '02:30' }, 'America/New_York', '2026-03-08T05:00:00Z')).toBe(
      '2026-03-09T06:30:00.000Z',
    );
    // US fall back: 2026-11-01 01:30 happens twice (05:30Z and 06:30Z).
    const s: Schedule = { type: 'daily', time: '01:30' };
    const first = next(s, 'America/New_York', '2026-11-01T04:00:00Z');
    expect(first).toBe('2026-11-01T05:30:00.000Z');
    expect(next(s, 'America/New_York', first!, first!)).toBe('2026-11-02T06:30:00.000Z');
  });

  it('anahtar dakikaya yuvarlanır', () => {
    expect(occurrenceKey(at('2026-11-16T10:00:42.123Z'))).toBe('2026-11-16T10:00:00.000Z');
  });

  it('Türkçe açıklama', () => {
    expect(describeSchedule({ type: 'weekly', days: [5, 1], time: '09:00' })).toBe('Pazartesi, Cuma 09:00');
    expect(describeSchedule({ type: 'interval', minutes: 120 })).toBe('2 saatte bir');
  });

  it('İngilizce açıklama', () => {
    expect(describeSchedule({ type: 'weekly', days: [5, 1], time: '09:00' }, 'en')).toBe(
      'Monday, Friday at 09:00',
    );
    expect(describeSchedule({ type: 'interval', minutes: 120 }, 'en')).toBe('Every 2 hours');
    expect(describeSchedule({ type: 'interval', minutes: 60 }, 'en')).toBe('Every hour');
    expect(describeSchedule({ type: 'hourly', minute: 5 }, 'en')).toBe('Every hour at :05');
  });
});

describe('PATCH şemaları', () => {
  it('gönderilmeyen alanlara varsayılan yazmaz', () => {
    expect(BotUpdate.parse({ name: 'x' })).toEqual({ name: 'x' });
    expect(RoutineUpdate.parse({ enabled: false })).toEqual({ enabled: false });
    expect(BotCreate.parse({ name: 'x' }).permissionMode).toBe('ask');
  });

  it('tek seferlik zamanı saat diliminde bir kez verir; çalıştıktan sonra boş döner', () => {
    const once = { type: 'once', date: '2026-11-20', time: '09:30' } as const;
    expect(zonedTime('2026-11-20', '09:30', 'Europe/Istanbul').toISOString()).toBe(
      '2026-11-20T06:30:00.000Z',
    );
    expect(zonedTime('2026-07-01', '12:00', 'Europe/Berlin').toISOString()).toBe('2026-07-01T10:00:00.000Z');
    const at = nextRun(once, 'Europe/Istanbul', new Date('2026-11-16T00:00:00Z'));
    expect(at?.toISOString()).toBe('2026-11-20T06:30:00.000Z');
    expect(nextRun(once, 'Europe/Istanbul', new Date('2026-11-21T00:00:00Z'), at)).toBeNull();
    expect(describeSchedule(once, 'en')).toBe('Once, on Nov 20, 2026 at 09:30');
    expect(Schedule.safeParse({ type: 'once', date: '20.11.2026', time: '09:30' }).success).toBe(false);
  });
});
