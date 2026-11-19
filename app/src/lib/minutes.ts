import { MAX_MINUTES_ITEMS } from '@yumakbot/shared';

/** The day a moment falls on here, as `YYYY-MM-DD`. */
export function localDay(iso: string): string {
  const d = new Date(iso);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** The longest line of a list of the minutes, as the server takes it. */
export const LINE_MAX = 1000;

/** One item per line; a bullet typed before it ("- ", "• ") is dropped, a minus sign ("-5%") kept. */
export const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.replace(/^\s*[-*•]\s+/, '').trim())
    .filter(Boolean);

/** Whether a list fits the minutes: so many items, none too long. */
export const fits = (items: string[]) =>
  items.length <= MAX_MINUTES_ITEMS && items.every((l) => l.length <= LINE_MAX);

/** A written item may hold a line break; in the editor each item keeps to one line. */
export const oneLine = (items: string[]) => items.map((x) => x.replace(/\s*\n\s*/g, ' ')).join('\n');
