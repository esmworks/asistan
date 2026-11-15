import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createTranslator,
  isLocale,
  pickLocale,
  type Catalog,
  type Locale,
  type Params,
} from '@yumakbot/shared/i18n';

/** Text of the menu bar app and its windows. */
const tr = {
  'status.starting': 'Açılıyor…',
  'status.remote': 'Uzak sunucu: {host}',
  'status.serverStarting': 'Sunucu açılıyor…',
  'status.running': 'Bu Mac: çalışıyor',
  'status.restarting': 'Sunucu yeniden başlatılıyor…',
  'status.stopped': 'Sunucu durdu',
  'status.failed': 'Sunucu açılamadı',
  'status.quitting': 'Kapatılıyor…',
  'dialog.gaveUp': 'YumakBot sunucusu tekrar tekrar durdu.',
  'dialog.gaveUpDetail': 'Günlükler menü çubuğundaki "Günlükleri göster" ile açılabilir.',
  'dialog.failed': 'YumakBot sunucusu açılamadı.',
  'menu.open': "YumakBot'u aç",
  'menu.connectRemote': 'Uzak sunucuya bağlan…',
  'menu.useLocal': "Bu Mac'teki sunucuyu kullan",
  'menu.openAtLogin': 'Girişte aç',
  'menu.showLogs': 'Günlükleri göster',
  'menu.quit': 'Çık',
  'menu.settings': 'Ayarlar…',
  'menu.about': 'YumakBot hakkında',
  'menu.edit': 'Düzen',
  'menu.view': 'Görünüm',
  'menu.window': 'Pencere',
  'edit.undo': 'Geri al',
  'edit.redo': 'Yinele',
  'edit.cut': 'Kes',
  'edit.copy': 'Kopyala',
  'edit.paste': 'Yapıştır',
  'edit.selectAll': 'Tümünü seç',
  'edit.copyLink': 'Bağlantıyı kopyala',
  'edit.copyImage': 'Görseli kopyala',
  'connect.title': 'Uzak sunucuya bağlan',
  'connect.noPermission': 'İzin yok',
  'connect.noResponse': 'Sunucu yanıt vermedi ({status})',
  'error.httpsRequired': 'Uzak sunucu adresi https:// ile başlamalı',
  'error.noKeychain': 'Anahtar güvenli biçimde saklanamıyor (anahtar zinciri yok)',
  'error.startTimeout': 'Sunucu 60 saniyede açılmadı',
  'error.startExit': 'Sunucu açılamadı (çıkış {code}): {stderr}',
  'error.oldAppTitle': "Önce Asistan'ı kapatın",
  'error.oldAppRunning':
    "YumakBot, Asistan'ın yeni adı. Botlarınız ve sohbetleriniz Asistan açıkken taşınamıyor. Asistan'ı kapatıp YumakBot'u yeniden açın; hepsi buraya gelir.",
} satisfies Catalog;

export type DesktopKey = keyof typeof tr;

const en: Catalog<DesktopKey> = {
  'status.starting': 'Starting…',
  'status.remote': 'Remote server: {host}',
  'status.serverStarting': 'Starting the server…',
  'status.running': 'This Mac: running',
  'status.restarting': 'Restarting the server…',
  'status.stopped': 'Server stopped',
  'status.failed': 'Server could not start',
  'status.quitting': 'Quitting…',
  'dialog.gaveUp': 'The YumakBot server keeps stopping.',
  'dialog.gaveUpDetail': 'Open the logs with "Show logs" in the menu bar.',
  'dialog.failed': 'The YumakBot server could not start.',
  'menu.open': 'Open YumakBot',
  'menu.connectRemote': 'Connect to a remote server…',
  'menu.useLocal': "Use this Mac's server",
  'menu.openAtLogin': 'Open at login',
  'menu.showLogs': 'Show logs',
  'menu.quit': 'Quit',
  'menu.settings': 'Settings…',
  'menu.about': 'About YumakBot',
  'menu.edit': 'Edit',
  'menu.view': 'View',
  'menu.window': 'Window',
  'edit.undo': 'Undo',
  'edit.redo': 'Redo',
  'edit.cut': 'Cut',
  'edit.copy': 'Copy',
  'edit.paste': 'Paste',
  'edit.selectAll': 'Select all',
  'edit.copyLink': 'Copy link address',
  'edit.copyImage': 'Copy image',
  'connect.title': 'Connect to a remote server',
  'connect.noPermission': 'Not allowed',
  'connect.noResponse': 'The server did not respond ({status})',
  'error.httpsRequired': 'The remote server address must start with https://',
  'error.noKeychain': 'The key cannot be stored securely (no keychain)',
  'error.startTimeout': 'The server did not start within 60 seconds',
  'error.startExit': 'The server could not start (exit {code}): {stderr}',
  'error.oldAppTitle': 'Quit Asistan first',
  'error.oldAppRunning':
    'YumakBot is the new name of Asistan. Your bots and chats cannot be moved over while Asistan is open. Quit Asistan and open YumakBot again; everything comes along.',
};

const CATALOGS = { tr, en };
let current: Locale = pickLocale([]);
let translate = createTranslator(CATALOGS, current);

export function t(key: DesktopKey, params?: Params): string {
  return translate(key, params);
}

export function locale(): Locale {
  return current;
}

/** The app's last language, else the system's preferred languages. */
export function loadLocale(dir: string, systemLanguages: string[]): Locale {
  const file = join(dir, 'locale');
  let saved: string | null = null;
  try {
    if (existsSync(file)) saved = readFileSync(file, 'utf8').trim();
  } catch {
    // Unreadable: use the system's languages.
  }
  return setLocale(isLocale(saved) ? saved : pickLocale(systemLanguages));
}

export function setLocale(next: Locale): Locale {
  current = next;
  translate = createTranslator(CATALOGS, next);
  return next;
}

export function saveLocale(dir: string, next: Locale) {
  writeFileSync(join(dir, 'locale'), `${next}\n`);
}
