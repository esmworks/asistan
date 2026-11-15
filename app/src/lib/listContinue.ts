/**
 * Shift+Enter inside a Markdown list item: the next line starts with the next marker (`- `, `* `
 * or the next number). On an empty item the marker is removed instead, which ends the list.
 * Null when the caret is not at the end of a list item, so the key does what it always does.
 */
export function continueList(text: string, caret: number): { text: string; caret: number } | null {
  const start = text.lastIndexOf('\n', caret - 1) + 1;
  const end = text.indexOf('\n', caret);
  const lineEnd = end === -1 ? text.length : end;
  if (caret !== lineEnd) return null;
  const line = text.slice(start, lineEnd);
  const m = /^(\s*)([-*]|(\d+)\.)( +)(.*)$/.exec(line);
  if (!m) return null;
  const [, indent, marker, num, gap, rest] = m;
  if (!rest!.trim()) {
    const next = text.slice(0, start) + text.slice(lineEnd);
    return { text: next, caret: start };
  }
  const nextMarker = num !== undefined ? `${Number(num) + 1}.` : marker!;
  const insert = `\n${indent}${nextMarker}${gap}`;
  const after = num !== undefined ? renumberFrom(text.slice(caret), indent!) : text.slice(caret);
  return { text: text.slice(0, caret) + insert + after, caret: caret + insert.length };
}

/**
 * A numbered item went in above: the items of the same list below move up by one, so the list
 * does not count the same number twice. Deeper lines (sub-items) are passed over; the list ends
 * at the first line that is neither.
 */
function renumberFrom(rest: string, indent: string): string {
  const lines = rest.split('\n');
  // lines[0] is what followed the caret on its own line: empty, since the caret is at the end.
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const item = /^(\s*)(\d+)\.( +.*)$/.exec(line);
    if (item && item[1] === indent) {
      lines[i] = `${indent}${Number(item[2]) + 1}.${item[3]}`;
      continue;
    }
    const lead = /^(\s*)/.exec(line)![1]!;
    if (line.trim() && lead.length > indent.length) continue;
    break;
  }
  return lines.join('\n');
}
