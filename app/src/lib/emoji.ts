/**
 * The emoji the composer's picker offers, from the Unicode data bundled with the app (no network),
 * loaded the first time the picker opens.
 */

export interface Emoji {
  emoji: string;
  /** English name, and the name with its keywords, lower case, searched by the picker. */
  name: string;
  words: string;
  group: EmojiGroup;
  /** The Emoji version that added it; a system older than that draws it as an empty box. */
  version: number;
}

/** The picker's sections, in Unicode's order; skin tone swatches on their own are left out. */
export const EMOJI_GROUPS = [
  'smileys',
  'people',
  'animals',
  'food',
  'travel',
  'activities',
  'objects',
  'symbols',
  'flags',
] as const;
export type EmojiGroup = (typeof EMOJI_GROUPS)[number];

/** Unicode's group numbers, as the data gives them, to the picker's sections. */
const GROUP_OF: Record<number, EmojiGroup> = {
  0: 'smileys',
  1: 'people',
  3: 'animals',
  4: 'food',
  5: 'travel',
  6: 'activities',
  7: 'objects',
  8: 'symbols',
  9: 'flags',
};

interface Raw {
  emoji: string;
  label: string;
  tags?: string[];
  group?: number;
  order?: number;
  version?: number;
}

/** The entries the picker shows, in order. Pure, so it can be tested on a few rows. */
export function toEmojis(raw: readonly Raw[]): Emoji[] {
  return raw
    .filter((r) => r.group !== undefined && GROUP_OF[r.group])
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((r) => ({
      emoji: r.emoji,
      name: r.label.toLowerCase(),
      words: [r.label, ...(r.tags ?? [])].join(' ').toLowerCase(),
      group: GROUP_OF[r.group!]!,
      version: r.version ?? 0,
    }));
}

let loaded: Promise<Emoji[]> | null = null;

/** Every emoji this system can draw. */
export function loadEmojis(): Promise<Emoji[]> {
  loaded ??= import('emojibase-data/en/data.json').then((m) => {
    const all = toEmojis(m.default as Raw[]);
    const newest = newestDrawn(all, canDraw());
    return newest === null ? all : all.filter((e) => e.version <= newest);
  });
  return loaded;
}

/**
 * The newest Emoji version this system draws, found by drawing the first emoji of each version,
 * newest first; null when that cannot be told (no canvas), and then nothing is left out.
 */
export function newestDrawn(list: readonly Emoji[], draws: ((emoji: string) => boolean) | null): number | null {
  if (!draws) return null;
  const firsts = new Map<number, string>();
  for (const e of list) if (!firsts.has(e.version)) firsts.set(e.version, e.emoji);
  const versions = [...firsts.keys()].sort((a, b) => b - a);
  for (const v of versions) if (draws(firsts.get(v)!)) return v;
  return null;
}

/**
 * Whether the system draws an emoji as one picture in colour. An emoji it does not know comes
 * out as a grey box, or as the separate pictures it is made of, wider than one.
 */
function canDraw(): ((emoji: string) => boolean) | null {
  if (typeof document === 'undefined') return null;
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  } catch {
    return null;
  }
  if (!ctx) return null;
  const size = 32;
  ctx.canvas.width = size * 2;
  ctx.canvas.height = size;
  ctx.font = `${size - 8}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
  ctx.textBaseline = 'middle';
  const one = ctx.measureText('😀').width;
  return (emoji) => {
    if (ctx.measureText(emoji).width > one * 1.4) return false;
    ctx.clearRect(0, 0, size * 2, size);
    ctx.fillStyle = '#000';
    ctx.fillText(emoji, 0, size / 2);
    const px = ctx.getImageData(0, 0, size * 2, size).data;
    for (let i = 0; i < px.length; i += 4) {
      const [r, g, b, a] = [px[i]!, px[i + 1]!, px[i + 2]!, px[i + 3]!];
      if (a > 64 && (Math.abs(r - g) > 24 || Math.abs(g - b) > 24 || Math.abs(r - b) > 24)) return true;
    }
    return false;
  };
}

/**
 * Entries whose name or a keyword starts with each word of the query; those it names come before
 * those only a keyword finds, so "pizza" gives the pizza before what goes on one.
 */
export function searchEmojis(list: readonly Emoji[], query: string): Emoji[] {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [...list];
  const matches = (text: string) => {
    const parts = text.split(/[\s:,]+/);
    return words.every((w) => parts.some((p) => p.startsWith(w)));
  };
  const named: Emoji[] = [];
  const tagged: Emoji[] = [];
  for (const e of list) {
    if (matches(e.name)) named.push(e);
    else if (matches(e.words)) tagged.push(e);
  }
  return [...named, ...tagged];
}

const RECENT_KEY = 'yumakbot.recentEmoji';
const RECENT_MAX = 16;

/** The emoji this person picked lately, newest first; kept in this browser only. */
export function recentEmojis(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

export function noteRecentEmoji(emoji: string): void {
  try {
    const next = [emoji, ...recentEmojis().filter((e) => e !== emoji)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // A browser that keeps nothing simply has no recent row.
  }
}
