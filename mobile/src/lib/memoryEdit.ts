import { untilDay, untilEndOfDay } from '@leafbot/app/src/lib/memoryNotes';
import type { Memory } from '@leafbot/shared';

/** A day typed by hand: year-month-day that exists on the calendar. */
export function isDay(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d;
}

/**
 * What a note's edit changes: its words and/or the time it is true until. An empty day clears the
 * end; a day left as it was keeps the exact time the bot gave. Empty when nothing changed.
 */
export function notePatch(
  m: Pick<Memory, 'content' | 'validUntil'>,
  content: string,
  until: string,
): { content?: string; validUntil?: string | null } {
  const before = m.validUntil ? untilDay(m.validUntil) : '';
  return {
    ...(content !== m.content && { content }),
    ...(until !== before && { validUntil: until ? untilEndOfDay(until) : null }),
  };
}
