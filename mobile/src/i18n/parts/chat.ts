/** Words only the phone app's chat screens use; the rest come from the web app's catalog. */
export const tr = {
  'chat.attachPhoto': 'Fotoğraf seç',
  'chat.attachCamera': 'Fotoğraf çek',
  'chat.attachFile': 'Dosya seç',
  'chat.cameraDenied': 'Kamera izni verilmedi. Ayarlardan açabilirsin.',
};

export const en: Record<keyof typeof tr, string> = {
  'chat.attachPhoto': 'Choose a photo',
  'chat.attachCamera': 'Take a photo',
  'chat.attachFile': 'Choose a file',
  'chat.cameraDenied': 'Camera access was not allowed. You can turn it on in Settings.',
};
