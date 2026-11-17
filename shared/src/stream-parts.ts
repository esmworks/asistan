/** A piece of a reply still streaming in: its text from `from`, or a card asked at that point. */
export type StreamPart<T> =
  { kind: 'text'; from: number; text: string; live: boolean } | { kind: 'card'; card: T };

/**
 * Splits a streaming reply where its cards were asked. The reply is saved only when the turn ends,
 * so a card asked on the way would otherwise sit above everything the bot wrote. `at` is how much
 * of the text had arrived when the card did; only the text after the last card is still being written.
 */
export function streamParts<T>(text: string, cards: { card: T; at: number }[]): StreamPart<T>[] {
  const parts: StreamPart<T>[] = [];
  let from = 0;
  // A stable sort keeps cards asked at the same point in the order they were asked.
  for (const { card, at } of [...cards].sort((a, b) => a.at - b.at)) {
    const to = Math.min(Math.max(at, from), text.length);
    if (to > from) parts.push({ kind: 'text', from, text: text.slice(from, to), live: false });
    parts.push({ kind: 'card', card });
    from = to;
  }
  if (from < text.length) parts.push({ kind: 'text', from, text: text.slice(from), live: true });
  return parts;
}
