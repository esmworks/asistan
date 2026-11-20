import { describe, expect, it } from 'vitest';
import { markedName, markupSize, pinNotes, type Mark } from './markup';

describe('picture markup', () => {
  it('draws on a large picture at a smaller size, keeping its shape', () => {
    expect(markupSize(4800, 2400)).toEqual({ width: 2400, height: 1200 });
    expect(markupSize(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it('numbers the notes as the pins are numbered, skipping pins without one', () => {
    const marks: Mark[] = [
      { kind: 'pin', x: 1, y: 1, note: 'Bu düğme kaymış' },
      { kind: 'stroke', color: 'red', points: [{ x: 0, y: 0 }] },
      { kind: 'pin', x: 2, y: 2, note: ' ' },
      { kind: 'pin', x: 3, y: 3, note: 'Renk daha koyu olsun' },
    ];
    expect(pinNotes(marks, 'İşaretler:')).toBe('İşaretler:\n1. Bu düğme kaymış\n3. Renk daha koyu olsun');
    expect(pinNotes([], 'İşaretler:')).toBe('');
  });

  it('names the marked copy after the original', () => {
    expect(markedName('ekran.jpg', 'isaretli')).toBe('ekran-isaretli.png');
    expect(markedName('a.b.png', 'marked')).toBe('a.b-marked.png');
  });
});
