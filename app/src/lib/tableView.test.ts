import { cellValue, type TableRow } from '@yumakbot/shared';
import { describe, expect, it } from 'vitest';
import { cellDraft, cellLabel, filterRows } from './tableView';

const row = (id: string, values: TableRow['values']): TableRow => ({
  id,
  values,
  createdAt: '',
  updatedAt: '',
});

describe('table view', () => {
  it('finds rows by text in any cell, ignoring case', () => {
    const rows = [row('a', { Ad: 'İstanbul', N: 3 }), row('b', { Ad: 'Ankara', N: 34 })];
    expect(filterRows(rows, 'istanbul', 'tr').map((r) => r.id)).toEqual(['a']);
    expect(filterRows(rows, '34', 'tr').map((r) => r.id)).toEqual(['b']);
    expect(filterRows(rows, '  ', 'tr')).toHaveLength(2);
  });

  it('finds a row by the value as the grid shows it', () => {
    const rows = [row('a', { N: 125000, B: true }), row('b', { N: 7, B: false })];
    const tr = new Intl.NumberFormat('tr-TR');
    const shown = (r: TableRow) => [
      cellLabel(r.values.N, { name: 'N', type: 'number' }, tr, 'Evet', 'Hayır'),
      cellLabel(r.values.B, { name: 'B', type: 'bool' }, tr, 'Evet', 'Hayır'),
    ];
    expect(filterRows(rows, '125.000', 'tr', shown).map((r) => r.id)).toEqual(['a']);
    expect(filterRows(rows, 'evet', 'tr', shown).map((r) => r.id)).toEqual(['a']);
    expect(filterRows(rows, 'hayır', 'tr', shown).map((r) => r.id)).toEqual(['b']);
  });

  it('shows numbers in the language and yes/no in words', () => {
    const tr = new Intl.NumberFormat('tr-TR');
    expect(cellLabel(1250.5, { name: 'N', type: 'number' }, tr, 'evet', 'hayır')).toBe('1.250,5');
    expect(cellLabel(true, { name: 'B', type: 'bool' }, tr, 'evet', 'hayır')).toBe('evet');
    expect(cellLabel(null, { name: 'T', type: 'text' }, tr, 'evet', 'hayır')).toBe('');
  });

  it('an edit box saved unchanged keeps the value', () => {
    for (const n of [1.125, 1250.5, -2, 0.125, 1000]) {
      const back = cellValue('number', cellDraft(n));
      expect(back).toEqual({ ok: true, value: n });
    }
    expect(cellValue('bool', cellDraft(false))).toEqual({ ok: true, value: false });
  });
});
