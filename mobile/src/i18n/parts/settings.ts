/** Words only the phone app's settings screens use; the rest come from the web app's catalog. */
export const tr = {
  'settings.languageHint':
    'Botların istemi ve sohbete yazılan sistem mesajları bu dilde olur. Uygulamanın kendisi telefonun dilini izler.',
  'about.name': 'Yumak Bot',
  'about.copyright': 'Copyright © 2026 esmworks (Erhan Erbaş)',
  'provider.modelMore': '{count} model daha; aramak için yazın',
  'push.hint': 'Uygulama kapalıyken bu telefona gelir.',
  'push.noKey': 'Sunucuda Apple anahtarı yok, bu yüzden bildirim gönderemiyor. Bağlantı bölümünden ekleyin.',
  'push.allow': 'Bildirimlere izin ver',
  'push.blocked': 'Bildirimler kapalı',
  'push.blockedHint': "iPhone Ayarları'nda Yumak Bot için bildirimlere izin verin.",
  'push.testSent': 'Gönderildi; birkaç saniye içinde gelmeli.',
};

export const en: Record<keyof typeof tr, string> = {
  'settings.languageHint':
    "The bots' prompt and the system messages in conversations use this language. The app itself follows the phone's language.",
  'about.name': 'Yumak Bot',
  'about.copyright': 'Copyright © 2026 esmworks (Erhan Erbaş)',
  'provider.modelMore': '{count} more models; type to search',
  'push.hint': 'Shown on this phone while the app is closed.',
  'push.noKey': 'The server has no Apple key, so it cannot send notifications. Add one under Connection.',
  'push.allow': 'Allow notifications',
  'push.blocked': 'Notifications are off',
  'push.blockedHint': 'Allow notifications for Yumak Bot in the iPhone Settings.',
  'push.testSent': 'Sent; it should arrive in a few seconds.',
};
