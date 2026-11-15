import { describe, expect, it } from 'vitest';
import { snoozeTimes } from './snooze';

describe('erteleme', () => {
  it('bir saat sonrasını, yarın sabahı ve gelecek pazartesi sabahını verir', () => {
    // A Wednesday afternoon.
    const now = new Date(2026, 10, 18, 15, 30);
    const [hour, tomorrow, nextWeek] = snoozeTimes(now);
    expect(hour!.at.getTime() - now.getTime()).toBe(3_600_000);
    expect([tomorrow!.at.getDate(), tomorrow!.at.getHours()]).toEqual([19, 9]);
    expect([nextWeek!.at.getDay(), nextWeek!.at.getDate(), nextWeek!.at.getHours()]).toEqual([1, 23, 9]);
  });

  it('pazartesi günü gelecek haftanın pazartesisini verir', () => {
    const monday = new Date(2026, 10, 16, 8, 0);
    expect(snoozeTimes(monday)[2]!.at.getDate()).toBe(23);
  });
});
