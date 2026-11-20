/** Words only the phone app's apps screens use; the rest come from the web app's catalog. */
export const tr = {
  'apps.loadFailed': 'Uygulamalar yüklenemedi',
  'apps.catalogUnknown': 'Bu uygulama listede yok.',
  'apps.headerNameBlocked': 'Bu başlık uygulamanın kendisi tarafından ayarlanır, değiştirilemez.',
};

export const en: Record<keyof typeof tr, string> = {
  'apps.loadFailed': 'The apps could not be loaded',
  'apps.catalogUnknown': 'This app is not in the list.',
  'apps.headerNameBlocked': 'This header is set by the app itself and cannot be changed.',
};
