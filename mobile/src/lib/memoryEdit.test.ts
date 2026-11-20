import { describe, expect, it } from 'vitest';
import { isDay, notePatch } from './memoryEdit';

describe('isDay', () => {
  it('accepts a real day and refuses the rest', () => {
    expect(isDay('2026-11-27')).toBe(true);
    expect(isDay('2026-02-30')).toBe(false);
    expect(isDay('27.11.2026')).toBe(false);
    expect(isDay('')).toBe(false);
  });
});

describe('notePatch', () => {
  const iso = new Date(2026, 10, 27, 10, 30).toISOString();
  it("is empty when nothing changed, and keeps the bot's exact time for the same day", () => {
    expect(notePatch({ content: 'a', validUntil: iso }, 'a', '2026-11-27')).toEqual({});
  });
  it('sets, changes and clears the end', () => {
    expect(notePatch({ content: 'a', validUntil: null }, 'a', '2026-12-01').validUntil).toBe(
      new Date(2026, 11, 1, 23, 59).toISOString(),
    );
    expect(notePatch({ content: 'a', validUntil: iso }, 'a', '')).toEqual({ validUntil: null });
  });
  it('carries new words', () => {
    expect(notePatch({ content: 'a', validUntil: null }, 'b', '')).toEqual({ content: 'b' });
  });
});
