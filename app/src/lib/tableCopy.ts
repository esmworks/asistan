/** A table's cells as text, row by row; the first row is the header. */
export type TableRows = string[][];

/** Reads a rendered table's rows, header first. */
export function readTable(table: HTMLTableElement): TableRows {
  return [...table.rows].map((row) => [...row.cells].map((cell) => (cell.textContent ?? '').trim()));
}

/** The table as Markdown, with `|` in cells escaped. */
export function toMarkdown(rows: TableRows): string {
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const line = (r: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => (r[i] ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`;
  return [line(rows[0]!), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n');
}

/** The table as CSV, quoting cells that need it. */
export function toCsv(rows: TableRows): string {
  const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return rows.map((r) => r.map(cell).join(',')).join('\r\n');
}
