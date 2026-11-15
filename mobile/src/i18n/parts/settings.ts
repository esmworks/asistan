/** Words only the phone app's settings screens use; the rest come from the web app's catalog. */
export const tr = {
  'settings.languageHint':
    'Botların istemi ve sohbete yazılan sistem mesajları bu dilde olur. Uygulamanın kendisi telefonun dilini izler.',
  'about.name': 'Yumak Bot',
  'about.copyright': 'Copyright © 2026 esmworks (Erhan Erbaş)',
  'provider.modelMore': '{count} model daha; aramak için yazın',
};

export const en: Record<keyof typeof tr, string> = {
  'settings.languageHint':
    "The bots' prompt and the system messages in conversations use this language. The app itself follows the phone's language.",
  'about.name': 'Yumak Bot',
  'about.copyright': 'Copyright © 2026 esmworks (Erhan Erbaş)',
  'provider.modelMore': '{count} more models; type to search',
};
