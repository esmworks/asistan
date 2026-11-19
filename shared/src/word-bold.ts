/**
 * Bold that Markdown leaves as asterisks. A closing `**` right after punctuation closes only when
 * a space or punctuation follows, so a suffix written onto a quoted word, as Turkish does
 * (`**"Yenile"**ye`), keeps the asterisks on screen. Renderers pass the text they were left with
 * through this, so a pair still standing in it shows as bold.
 */
const LEFT_BOLD = /\*\*(?=[^\s*])([^*\n]*?[^\s*])\*\*/g;

export interface BoldPiece {
  text: string;
  bold: boolean;
}

/** The text cut into plain and bold pieces, or null when no pair of `**` stands in it. */
export function leftoverBold(text: string): BoldPiece[] | null {
  if (!text.includes('**')) return null;
  const pieces: BoldPiece[] = [];
  let last = 0;
  for (const m of text.matchAll(LEFT_BOLD)) {
    if (m.index > last) pieces.push({ text: text.slice(last, m.index), bold: false });
    pieces.push({ text: m[1]!, bold: true });
    last = m.index + m[0].length;
  }
  if (!pieces.length) return null;
  if (last < text.length) pieces.push({ text: text.slice(last), bold: false });
  return pieces;
}
