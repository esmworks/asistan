/** The `$name` being typed just before the caret, if any. */
export function skillQuery(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|[\s(])\$([\p{L}\p{N}_-]*)$/u.exec(text.slice(0, caret));
  if (!m) return null;
  const query = m[2]!;
  return { start: caret - query.length - 1, query };
}

/** The text with the `$name` being typed replaced by the picked skill, and where the caret goes. */
export function pickSkill(text: string, caret: number, name: string): { text: string; caret: number } | null {
  const q = skillQuery(text, caret);
  if (!q) return null;
  const rest = text.slice(caret);
  const spaced = rest.startsWith(' ');
  const insert = `$${name}${spaced ? '' : ' '}`;
  return { text: text.slice(0, q.start) + insert + rest, caret: q.start + insert.length + (spaced ? 1 : 0) };
}
