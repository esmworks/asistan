import { describe, expect, it } from 'vitest';
import { badgeCount, isUnread, nextSeen, titleWithCount } from './unread';

const s = (botId: string, repliedAt: string | null) => ({ botId, repliedAt });

describe('okunmamış yanıtlar', () => {
  it('son bakıştan sonra gelen yanıtı okunmamış sayar', () => {
    const seen = { a: '2026-11-01T10:00:00.000Z' };
    expect(isUnread(s('a', '2026-11-01T10:00:00.000Z'), seen)).toBe(false);
    expect(isUnread(s('a', '2026-11-01T10:05:00.000Z'), seen)).toBe(true);
    expect(isUnread(s('a', null), seen)).toBe(false);
  });

  it('iz tutmamış cihazda hiçbir şeyi okunmamış göstermez; izi olmayan yeni bot her yanıtı sayar', () => {
    expect(isUnread(s('a', '2026-11-01T10:00:00.000Z'), null)).toBe(false);
    expect(isUnread(s('yeni', '2026-11-01T10:00:00.000Z'), {})).toBe(true);
  });

  it('ilk listeyi okunmuş kabul eder, listeden çıkan botların izini siler', () => {
    const first = nextSeen(null, [s('a', '2026-11-01T10:00:00.000Z'), s('b', null)]);
    expect(first).toEqual({ a: '2026-11-01T10:00:00.000Z', b: '' });
    expect(nextSeen(first, [s('b', null)])).toEqual({ b: '' });
  });

  it('rozet sayısını sınırlar ve başlığa yazar', () => {
    expect(badgeCount(-3)).toBe(0);
    expect(badgeCount(2.7)).toBe(2);
    expect(badgeCount(5000)).toBe(999);
    expect(badgeCount(Number.NaN)).toBe(0);
    expect(titleWithCount('YumakBot', 0)).toBe('YumakBot');
    expect(titleWithCount('YumakBot', 3)).toBe('(3) YumakBot');
  });
});
