import { tr as sidebar } from './parts/sidebar';
import { tr as chat } from './parts/chat';
import { tr as message } from './parts/message';
import { tr as panel } from './parts/panel';
import { tr as dialogs } from './parts/dialogs';
import { tr as settings } from './parts/settings';
import { tr as apps } from './parts/apps';

/** Turkish words only the phone app uses; the rest come from the web app's catalog. */
export const tr = {
  ...sidebar,
  ...chat,
  ...message,
  ...panel,
  ...dialogs,
  ...settings,
  ...apps,
  'common.retry': 'Tekrar dene',
  'common.ok': 'Tamam',

  'connect.title': 'Sunucuna bağlan',
  'connect.intro':
    'Botlar kendi sunucunda çalışır; bu telefon yalnızca pencere olur. Bilgisayarındaki ya da sunucundaki Yumak Bot’un adresini yaz.',
  'connect.url': 'Sunucu adresi',
  'connect.urlPlaceholder': '192.168.1.20:4319',
  'connect.submit': 'Bağlan',
  'connect.invalid': 'Bu bir adres değil',
  'connect.notYumakBot': 'Bu adreste bir Yumak Bot sunucusu yanıt vermedi',
  'connect.httpsOnly':
    'Bu adreste HTTPS ile yanıt veren bir Yumak Bot sunucusu yok. İnternetteki bir sunucu HTTPS ister; yine de düz http kullanmak için başına http:// yaz.',
  'connect.insecureTitle': 'Şifrelemeden bağlanılsın mı?',
  'connect.insecureText':
    '{host} internette ama düz http ile yanıt veriyor. Aradaki herkes erişim anahtarını, şifreni ve konuşmalarını okuyabilir. Neden gerektiğini bilmiyorsan https ile başlayan bir adres kullan.',
  'connect.insecureConfirm': 'Yine de bağlan',

  'offline.title': 'Sunucuya ulaşılamadı',
  'offline.text':
    '{host} yanıt vermiyor. Sunucunun açık olduğunu ve telefonun aynı ağda ya da VPN’de olduğunu denetle.',
  'offline.change': 'Başka sunucu',

  'login.key': 'Erişim anahtarı',
  'login.server': 'Sunucu: {host}',

  'bots.logout': 'Çıkış',
  'bots.loadFailed': 'Botlar yüklenemedi',

  'chat.back': 'Geri',
  'chat.loadFailed': 'Konuşma yüklenemedi',
  'chat.sendFailed': 'Mesaj gönderilemedi',
};

export type OwnKey = keyof typeof tr;
