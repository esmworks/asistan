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
  unicode: string;
  label: string;
  tags?: string[];
  group?: number;
  order?: number;
}

/** The entries the picker shows, in order. Pure, so it can be tested on a few rows. */
export function toEmojis(raw: readonly Raw[]): Emoji[] {
  return raw
    .filter((r) => r.group !== undefined && GROUP_OF[r.group])
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((r) => ({
      emoji: r.unicode,
      name: r.label.toLowerCase(),
      words: [r.label, ...(r.tags ?? [])].join(' ').toLowerCase(),
      group: GROUP_OF[r.group!]!,
    }));
}

let loaded: Promise<Emoji[]> | null = null;

export function loadEmojis(): Promise<Emoji[]> {
  loaded ??= import('emojibase-data/en/compact.json').then((m) => toEmojis(m.default as Raw[]));
  return loaded;
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
