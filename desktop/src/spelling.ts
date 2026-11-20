import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Spell checking in the app's text fields. The parts that need no Electron, so they can be tested:
 * whether it is on, which languages it checks and the right-click entries for a misspelled word.
 */

const SETTING_FILE = 'spelling.json';
/** More suggestions than this crowd the menu without helping. */
const MAX_SUGGESTIONS = 5;

/** On unless the person turned it off. */
export function readSpellingOn(dir: string): boolean {
  try {
    return (JSON.parse(readFileSync(join(dir, SETTING_FILE), 'utf8')) as { on?: unknown }).on !== false;
  } catch {
    return true;
  }
}

export function writeSpellingOn(dir: string, on: boolean) {
  writeFileSync(join(dir, SETTING_FILE), JSON.stringify({ on }));
}

/**
 * The languages to check where the app brings its own dictionaries (Windows, Linux): the
 * person's system languages it has one for, in their order, then the app's own two, so a
 * message in Turkish or English is not marked wrong word by word. macOS checks with the
 * system's own checker, which picks the language itself.
 */
export function spellingLanguages(preferred: readonly string[], available: readonly string[]): string[] {
  const has = new Map(available.map((l) => [l.toLowerCase(), l]));
  const out: string[] = [];
  const add = (l: string | undefined) => {
    if (l && !out.includes(l)) out.push(l);
  };
  for (const p of [...preferred, 'tr', 'tr-TR', 'en-US', 'en']) {
    const lower = p.toLowerCase();
    add(has.get(lower) ?? has.get(lower.split('-')[0]!) ?? undefined);
  }
  return out;
}

export interface SpellingEntry {
  label: string;
  enabled?: boolean;
  /** Puts the word in place of the misspelled one. */
  replace?: string;
  /** Adds the misspelled word to the person's dictionary. */
  learn?: string;
}

/**
 * The entries a right-click on a misspelled word starts with: what it could be, or that nothing
 * was found, and keeping the word as it is from then on.
 */
export function spellingEntries(
  word: string,
  suggestions: readonly string[],
  text: { none: string; learn: string },
): SpellingEntry[] {
  if (!word) return [];
  const picks = suggestions.slice(0, MAX_SUGGESTIONS).map((s) => ({ label: s, replace: s }));
  return [
    ...(picks.length ? picks : [{ label: text.none, enabled: false }]),
    { label: text.learn, learn: word },
  ];
}
