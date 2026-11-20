import type { Catalog, Locale } from '@leafbot/shared/i18n';
import { en as webEn } from '@leafbot/app/src/i18n/en';
import { tr as webTr, type MessageKey as WebKey } from '@leafbot/app/src/i18n/tr';
import { en } from './en';
import { tr, type OwnKey } from './tr';

/** Every key the phone app shows: the web app's, so both say the same thing, and its own. */
export type MessageKey = WebKey | OwnKey;

export const catalogs: Record<Locale, Partial<Catalog<MessageKey>>> = {
  tr: { ...webTr, ...tr },
  en: { ...webEn, ...en },
};
