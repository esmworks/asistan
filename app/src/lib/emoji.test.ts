import { beforeEach, describe, expect, it } from 'vitest';
import { loadEmojis, noteRecentEmoji, recentEmojis, searchEmojis, toEmojis } from './emoji';

describe('emoji picker data', () => {
  beforeEach(() => localStorage.clear());

  it('keeps the sections in order and leaves out skin tone swatches and loose letters', () => {
    const list = toEmojis([
      { unicode: '👍', label: 'thumbs up', tags: ['like'], group: 1, order: 2 },
      { unicode: '😀', label: 'grinning face', tags: ['smile'], group: 0, order: 1 },
      { unicode: '🏻', label: 'light skin tone', group: 2, order: 3 },
      { unicode: '🇦', label: 'regional indicator A' },
    ]);
    expect(list.map((e) => [e.emoji, e.group])).toEqual([
      ['😀', 'smileys'],
      ['👍', 'people'],
    ]);
  });

  it('finds an emoji by the start of its name or a keyword', async () => {
    const all = await loadEmojis();
    expect(all.length).toBeGreaterThan(1500);
    expect(searchEmojis(all, 'thumbs up').map((e) => e.emoji)).toContain('👍');
    expect(searchEmojis(all, 'pizz')[0]!.emoji).toBe('🍕');
    expect(searchEmojis(all, 'like').map((e) => e.emoji)).toContain('👍');
    expect(searchEmojis(all, 'zzqx')).toEqual([]);
    expect(searchEmojis(all, '  ')).toHaveLength(all.length);
  });

  it('remembers what was picked lately, newest first, once each', () => {
    noteRecentEmoji('😀');
    noteRecentEmoji('👍');
    noteRecentEmoji('😀');
    expect(recentEmojis()).toEqual(['😀', '👍']);
  });
});
