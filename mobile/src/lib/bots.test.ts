import type { Bot } from '@yumakbot/shared';
import { describe, expect, it } from 'vitest';
import { initialOf, ordered } from './bots';

const bot = (id: string, over: Partial<Bot> = {}): Bot =>
  ({ id, name: id, pinned: false, position: 0, archivedAt: null, ...over }) as Bot;

describe('ordered', () => {
  it('puts pinned bots first, then follows the list order', () => {
    const list = ordered([
      bot('c', { position: 2 }),
      bot('a', { position: 0 }),
      bot('p', { pinned: true, position: 5 }),
      bot('b', { position: 1 }),
    ]);
    expect(list.map((b) => b.id)).toEqual(['p', 'a', 'b', 'c']);
  });

  it('leaves archived bots out', () => {
    expect(ordered([bot('a'), bot('x', { archivedAt: '2026-01-01T00:00:00Z' })]).map((b) => b.id)).toEqual([
      'a',
    ]);
  });
});

describe('initialOf', () => {
  it('takes the first letter in its language', () => {
    expect(initialOf('  iris', 'tr-TR')).toBe('İ');
    expect(initialOf('iris', 'en-US')).toBe('I');
  });

  it('keeps an emoji whole and gives nothing for an empty name', () => {
    expect(initialOf('🤖 Bot')).toBe('🤖');
    expect(initialOf('   ')).toBe('');
  });
});
