import { describe, expect, it } from 'vitest';
import { textDiff } from './text-diff';

const join = (parts: { type: string; text: string }[], keep: string) =>
  parts
    .filter((p) => p.type === 'same' || p.type === keep)
    .map((p) => p.text)
    .join('');

describe('textDiff', () => {
  it('marks the words that changed and keeps the rest', () => {
    expect(textDiff('Send the weekly report', 'Send the daily report')).toEqual([
      { type: 'same', text: 'Send the ' },
      { type: 'removed', text: 'weekly' },
      { type: 'added', text: 'daily' },
      { type: 'same', text: ' report' },
    ]);
  });

  it('puts either version back together from its parts', () => {
    const before = 'Check the inbox.\nReply to urgent mail.\nSummarise the rest.';
    const after = 'Check the inbox every morning.\nSummarise the rest in three lines.';
    const parts = textDiff(before, after);
    expect(join(parts, 'removed')).toBe(before);
    expect(join(parts, 'added')).toBe(after);
  });

  it('handles empty versions', () => {
    expect(textDiff('', 'new')).toEqual([{ type: 'added', text: 'new' }]);
    expect(textDiff('old', '')).toEqual([{ type: 'removed', text: 'old' }]);
    expect(textDiff('same', 'same')).toEqual([{ type: 'same', text: 'same' }]);
  });

  it('compares a very long text line by line and stays correct', () => {
    const before = Array.from({ length: 2500 }, (_, i) => `line ${i} word`).join('\n');
    const after = before.replace('line 1200 word', 'line 1200 changed');
    const parts = textDiff(before, after);
    expect(join(parts, 'removed')).toBe(before);
    expect(join(parts, 'added')).toBe(after);
    expect(parts.filter((p) => p.type !== 'same')).toHaveLength(2);
  });
});
