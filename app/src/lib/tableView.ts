import { cellText, type CellValue, type TableColumn, type TableRow } from '@yumakbot/shared';

/** Rows the table window draws at once; a search narrows a longer table. */
export const SHOWN_ROWS = 300;

/**
 * The rows with the text in any cell, ignoring case: as stored ("1250.5", "true") or as the grid
 * shows it (`shown`: "1.250,5", "Evet"), so what the person sees is what they find. Every row when
 * the search is empty.
 */
export function filterRows(
  rows: readonly TableRow[],
  search: string,
  locale: string,
  shown: (row: TableRow) => string[] = () => [],
): TableRow[] {
  const q = search.trim().toLocaleLowerCase(locale);
  if (!q) return [...rows];
  return rows.filter((r) =>
    [...Object.values(r.values).map((v) => cellText(v)), ...shown(r)].some((text) =>
      text.toLocaleLowerCase(locale).includes(q),
    ),
  );
}

/**
 * A cell as the person reads it: numbers in their language's digits, a date as written, yes or
 * no in words, empty as nothing.
 */
export function cellLabel(
  value: CellValue | undefined,
  column: TableColumn,
  number: Intl.NumberFormat,
  yes: string,
  no: string,
) {
  if (value === null || value === undefined) return '';
  if (column.type === 'number' && typeof value === 'number') return number.format(value);
  return cellText(value, yes, no);
}

/**
 * The text an edit box starts with, which saved unchanged gives back the same value. A number has
 * no grouping, and "1.125" gets a trailing zero: three digits after a lone separator read as
 * thousands.
 */
export function cellDraft(value: CellValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    const s = String(value);
    return /^-?\d+\.\d{3}$/.test(s) ? `${s}0` : s;
  }
  return value;
}
