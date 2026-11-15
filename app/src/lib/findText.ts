/** Lower case in a way that keeps each character's place: Turkish İ/ı and the default rules. */
function fold(s: string): string {
  const tr = s.toLocaleLowerCase('tr');
  return tr.length === s.length ? tr : s.toLowerCase();
}

/**
 * Where `query` occurs in `text`, as [start, end) pairs. Case is ignored, and any run of spaces
 * or line breaks in the query matches any run in the text, as the server's search does.
 */
export function findOffsets(text: string, query: string): [number, number][] {
  const words = fold(query.trim()).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(escaped.join('\\s+'), 'g');
  const out: [number, number][] = [];
  const folded = fold(text);
  for (const m of folded.matchAll(re)) out.push([m.index, m.index + m[0].length]);
  return out;
}

/** Ranges over the text inside `root` where `query` occurs, one text node at a time. */
export function findRanges(root: Node, query: string): Range[] {
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue ?? '';
    if (text.trim().length < 2) continue;
    for (const [start, end] of findOffsets(text, query)) {
      const r = document.createRange();
      r.setStart(node, start);
      r.setEnd(node, end);
      ranges.push(r);
    }
  }
  return ranges;
}
