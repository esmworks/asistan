/**
 * A message's Markdown as one plain line: tables, headings, emphasis, links and code fences
 * are reduced to their words, so a quote of it reads like the text the person saw.
 */
export function plainText(markdown: string): string {
  return (
    markdown
      // Code fences keep their content.
      .replace(/^```.*$/gm, '')
      // Table separator rows (| --- | :-: |).
      .replace(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/gm, '')
      // Images and links keep their words.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      // Headings, quotes and list markers at the start of a line.
      .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
      // Table cell borders.
      .replace(/\s*\|\s*/g, ' ')
      // Emphasis and inline code marks.
      .replace(/(\*\*|__|\*|_|~~|`)(?=\S)([^\n]*?\S)\1/g, '$2')
      .replace(/`/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * A conversation's name from its first message: the words of its first line that has any, cut on a
 * word at about `max` letters; empty when the message has no words.
 */
export function titleFrom(markdown: string, max = 60): string {
  const line = markdown
    .split('\n')
    .map((l) => plainText(l))
    .find((l) => l.length > 0);
  return line ? quoteExcerpt(line, max) : '';
}

/** The start of a message to quote above a reply: plain text, cut on a word at about `max` letters. */
export function quoteExcerpt(markdown: string, max = 160): string {
  const text = plainText(markdown);
  if (text.length <= max) return text;
  // Never half of an emoji or another character outside the basic plane.
  const cut = text.slice(0, /[\uD800-\uDBFF]/.test(text[max - 1] ?? '') ? max - 1 : max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
