import type { Bot } from '@yumakbot/shared';

/** Active bots, pinned ones first, then each in its place in the list. */
export function ordered(bots: readonly Bot[]): Bot[] {
  return bots
    .filter((b) => !b.archivedAt)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.position - b.position);
}

/** The first letter of a name for its avatar; a whole emoji or accented letter, not half of one. */
export function initialOf(name: string, locale?: string): string {
  return (Array.from(name.trim())[0] ?? '').toLocaleUpperCase(locale);
}
