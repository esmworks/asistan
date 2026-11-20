import { createTranslator, pickLocale, type Locale, type Translate } from '@leafbot/shared/i18n';
import { getLocales } from 'expo-localization';
import { catalogs, type MessageKey } from './catalogs';

export type { MessageKey };
export type T = Translate<MessageKey>;

/** The phone's own language order picks the language; one the app does not speak falls back to the default. */
export const locale: Locale = pickLocale(getLocales().map((l) => l.languageTag));

export const t: T = createTranslator<MessageKey>(catalogs, locale);
