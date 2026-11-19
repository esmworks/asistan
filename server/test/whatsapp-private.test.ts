import { describe, expect, it } from 'vitest';
import { privateText } from '../src/channels/private-text';

describe('WhatsApp gizli mesaj süzgeci', () => {
  const dropped = [
    'Doğrulama kodunuz: 482913. Bu kodu kimseyle paylaşmayın.',
    '482913 is your Facebook confirmation code',
    'Your verification code is 7731',
    'Giriş kodu 55 12 90',
    'Garanti BBVA tek kullanımlık şifre: 913400',
    'WhatsApp code: 123-456. Do not share this code.',
    'Şifreniz değiştirildi. Siz yapmadıysanız bize bildirin.',
    'Your Instagram password was changed.',
    'Şifrenizi sıfırlamak için: https://example.com/reset?token=abc123',
    'Sign in: https://accounts.example.com/magic-link/xyz',
    'password: Kış2026!',
    'Kartım 4111 1111 1111 1111',
    'G-482913 is your Google verification code.',
  ];
  const kept = [
    'Ödeme yapıldı 15.000 TL, dekont ekte',
    'Merhaba, 3 adet 40 m³ soğuk oda için teklif rica ederim',
    'Fatura no 2026-1142 hakkında bilgi alabilir miyim?',
    'Yarın saat 14:30’da görüşelim',
    'Sipariş kodu ne zaman gelir?',
    'Teklifte kompresör modeli ZB45 olsun',
    'https://example.com/urunler/evaporator',
    '',
    // A payment's own details must reach the bot.
    'IBAN: TR33 0006 1005 1978 6457 8413 26, alıcı 3E Soğutma',
    'Dekont: işlem referans no 2026111900004812345, tutar 42.500,00 TL',
    'EFT gönderildi, sorgu numarası 7781203344',
  ];
  /**
   * Worded like a code, so left out (the bot sees a line saying one was): kept here so a change to
   * the filter that starts or stops dropping them is seen.
   */
  const leftOut = ['Havale yapıldı, işlem onay kodu 845123', 'https://example.com/blog/login-tips'];
  it.each(leftOut)('kod gibi göründüğü için atar: %s', (text) => expect(privateText(text)).toBe(true));
  it.each(dropped)('atar: %s', (text) => expect(privateText(text)).toBe(true));
  it.each(kept)('tutar: %s', (text) => expect(privateText(text)).toBe(false));
});
