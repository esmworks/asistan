import { describe, expect, it } from 'vitest';
import { isClockTime, personNameOf, pickable, scheduleOf } from './today';

describe('suggestion schedule', () => {
  it('starts from the rhythm the requests had', () => {
    expect(pickable({ type: 'weekdays', time: '08:30' })).toEqual({
      kind: 'weekdays',
      day: 1,
      time: '08:30',
    });
    expect(pickable({ type: 'weekly', days: [4], time: '17:00' })).toEqual({
      kind: 'weekly',
      day: 4,
      time: '17:00',
    });
    expect(pickable(null).kind).toBe('');
  });

  it('makes a schedule only from a rhythm and a valid time', () => {
    expect(scheduleOf({ kind: '', day: 1, time: '09:00' })).toBeNull();
    expect(scheduleOf({ kind: 'daily', day: 1, time: '9:00' })).toBeNull();
    expect(scheduleOf({ kind: 'daily', day: 1, time: '09:00' })).toEqual({ type: 'daily', time: '09:00' });
    expect(scheduleOf({ kind: 'weekly', day: 3, time: '18:45' })).toEqual({
      type: 'weekly',
      days: [3],
      time: '18:45',
    });
  });

  it('checks clock times', () => {
    expect(isClockTime('23:59')).toBe(true);
    expect(isClockTime('24:00')).toBe(false);
    expect(isClockTime('12:60')).toBe(false);
    expect(isClockTime('')).toBe(false);
  });
});

describe('personNameOf', () => {
  const people = [
    { id: 'a', displayName: 'Ayşe', username: 'ayse' },
    { id: 'b', displayName: null, username: 'bora' },
    { id: 'c', displayName: null, username: null },
  ];
  it('prefers the display name, then the username, then the owner label', () => {
    expect(personNameOf(people, 'a', 'Owner')).toBe('Ayşe');
    expect(personNameOf(people, 'b', 'Owner')).toBe('bora');
    expect(personNameOf(people, 'c', 'Owner')).toBe('Owner');
    expect(personNameOf(people, 'x', 'Owner', 'Someone')).toBe('Someone');
  });
});
