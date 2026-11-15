/**
 * Rows of a CSV or TSV text: quoted fields may hold the separator, quotes ("" for one) and line
 * breaks. The separator is a tab for TSV, else whichever of , and ; the first line uses more of.
 */
export function parseCsv(text: string, tsv = false): string[][] {
  const src = text.replace(/^\uFEFF/, '');
  const first = src.slice(0, src.indexOf('\n') >= 0 ? src.indexOf('\n') : undefined);
  const sep = tsv ? '\t' : first.split(';').length > first.split(',').length ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
