import { describe, expect, it } from 'vitest';
import { cellText, cellValue, findColumn } from './tables';

const ok = (type: Parameters<typeof cellValue>[0], raw: Parameters<typeof cellValue>[1]) => {
  const r = cellValue(type, raw);
  if (!r.ok) throw new Error(r.problem);
  return r.value;
};

describe('cellValue', () => {
  it('reads numbers written either way', () => {
    expect(ok('number', '1.250,5')).toBe(1250.5);
    expect(ok('number', '1,250.5')).toBe(1250.5);
    expect(ok('number', '12,5')).toBe(12.5);
    expect(ok('number', '3.75')).toBe(3.75);
    expect(ok('number', '1.250.000')).toBe(1250000);
    expect(ok('number', '0,250')).toBe(0.25);
    expect(ok('number', -4)).toBe(-4);
    expect(cellValue('number', 'on iki')).toEqual({ ok: false, problem: 'table.badNumber' });
  });

  it('keeps real dates only, with a time when given', () => {
    expect(ok('date', '2026-11-17')).toBe('2026-11-17');
    expect(ok('date', '2026-11-17T09:30:00')).toBe('2026-11-17 09:30');
    expect(ok('date', '2026-11-17 23:59')).toBe('2026-11-17 23:59');
    expect(cellValue('date', '2026-11-17 25:99').ok).toBe(false);
    expect(cellValue('date', '2026-11-17 12:60').ok).toBe(false);
    // A moment in a time zone is not a wall-clock time.
    expect(cellValue('date', '2026-11-17T09:30:00Z').ok).toBe(false);
    expect(cellValue('date', '2026-11-17T09:30+03:00').ok).toBe(false);
    expect(cellValue('date', '2026-02-30').ok).toBe(false);
    expect(cellValue('date', '17.11.2026').ok).toBe(false);
  });

  it('reads yes and no in both languages', () => {
    expect(ok('bool', 'Evet')).toBe(true);
    expect(ok('bool', 'no')).toBe(false);
    expect(ok('bool', true)).toBe(true);
    expect(cellValue('bool', 'belki').ok).toBe(false);
  });

  it('takes web addresses with or without a scheme, and nothing else', () => {
    expect(ok('url', 'ornek.com/a')).toBe('https://ornek.com/a');
    expect(ok('url', 'http://ornek.com')).toBe('http://ornek.com/');
    expect(cellValue('url', 'javascript:alert(1)').ok).toBe(false);
    expect(cellValue('url', 'merhaba').ok).toBe(false);
  });

  it('empties a cell with nothing, and refuses text that is too long', () => {
    expect(ok('number', '  ')).toBeNull();
    expect(ok('text', null)).toBeNull();
    expect(ok('text', 42)).toBe('42');
    expect(cellValue('text', 'x'.repeat(2001))).toEqual({ ok: false, problem: 'table.tooLong' });
  });
});

describe('cellText and findColumn', () => {
  it('writes cells as text and finds columns by name', () => {
    expect(cellText(true, 'evet', 'hayır')).toBe('evet');
    expect(cellText(null)).toBe('');
    expect(cellText(12.5)).toBe('12.5');
    expect(findColumn([{ name: 'Fiyat', type: 'number' }], ' fiyat ')?.type).toBe('number');
  });
});
