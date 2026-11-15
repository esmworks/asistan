import { INTL_LOCALE } from '@yumakbot/shared/i18n';
import { locale } from '@/i18n';

const tag = INTL_LOCALE[locale];
const dollars = new Intl.NumberFormat(tag, { style: 'currency', currency: 'USD' });
// A day key is a calendar date, not a moment: shown in UTC so no time zone shifts it.
const calendar = new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'long', timeZone: 'UTC' });
const calendarShort = new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** "$1.25"; a cost above zero that rounds to nothing still shows as one cent. */
export function usd(n: number): string {
  return n > 0 && n < 0.005 ? `<${dollars.format(0.01)}` : dollars.format(n);
}

/** A YYYY-MM-DD day: "16 Kasım", or short: "16 Kas". */
export function calendarDay(key: string, short = false): string {
  return (short ? calendarShort : calendar).format(new Date(`${key}T00:00:00Z`));
}
