/** A piece of a text compared with an earlier version: unchanged, added or taken out. */
export interface DiffPart {
  type: 'same' | 'added' | 'removed';
  text: string;
}

/** Above this many word pairs the comparison goes line by line, so a long text stays quick. */
const WORD_LIMIT = 4_000_000;

/**
 * What changed from `before` to `after`, word by word, with the spaces and line breaks between
 * words kept, so the parts put together read as either text. Long texts are compared by lines.
 */
export function textDiff(before: string, after: string): DiffPart[] {
  const words = (s: string) => s.match(/\s+|[^\s]+/g) ?? [];
  let a = words(before);
  let b = words(after);
  if (a.length * b.length > WORD_LIMIT) {
    const lines = (s: string) => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    a = lines(before);
    b = lines(after);
  }
  return merge(diffTokens(a, b));
}

/** The longest common subsequence, walked back into same/removed/added tokens. */
function diffTokens(a: string[], b: string[]): DiffPart[] {
  // Equal starts and ends need no table.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  // lcs[i][j]: common length of midA[i..] and midB[j..].
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = midA[i] === midB[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffPart[] = a.slice(0, start).map((text) => ({ type: 'same', text }));
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (midA[i] === midB[j]) {
      out.push({ type: 'same', text: midA[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ type: 'removed', text: midA[i++]! });
    } else {
      out.push({ type: 'added', text: midB[j++]! });
    }
  }
  while (i < n) out.push({ type: 'removed', text: midA[i++]! });
  while (j < m) out.push({ type: 'added', text: midB[j++]! });
  for (const text of a.slice(endA)) out.push({ type: 'same', text });
  return out;
}

/**
 * Joins neighbours of one type, and lets a space between two changes count as part of them, so
 * "a b" → "c d" reads as one replacement rather than four.
 */
function merge(parts: DiffPart[]): DiffPart[] {
  const out: DiffPart[] = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (last && last.type === p.type) last.text += p.text;
    else out.push({ ...p });
  }
  return out;
}
