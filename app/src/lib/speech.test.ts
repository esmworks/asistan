import { describe, expect, it } from 'vitest';
import { clampRate, pickVoice, speakable, speechLanguage } from './speech';

const voice = (name: string, lang: string, extra: Partial<SpeechSynthesisVoice> = {}) =>
  ({ name, lang, localService: true, default: false, voiceURI: name, ...extra }) as SpeechSynthesisVoice;

describe('sesli okuma', () => {
  it('Markdown işaretlerini ve kodu okumaz, her satırın sonunda durur', () => {
    expect(
      speakable('## Özet\n\n- **Satış** arttı, [rapor](https://x.y) hazır\n\n```js\nx()\n```\nBitti.'),
    ).toBe('Özet.\nSatış arttı, rapor hazır.\nBitti.');
  });

  it('emoji, çıplak adres, tablo çizgisi ve oku sesli okumaz', () => {
    expect(
      speakable(
        '✅ Tamam 🎉\n\n---\n\n| Ürün | Adet |\n|---|---:|\n| Elma | 3 |\n\nAyrıntı → https://ornek.com/a?b=1',
      ),
    ).toBe('Tamam.\nÜrün, Adet.\nElma, 3.\nAyrıntı.');
  });

  it('formül bloklarını ve HTML etiketlerini okumaz', () => {
    expect(speakable('Sonuç:\n$$\\frac{a}{b}$$\n<br>Son')).toBe('Sonuç:\nSon.');
  });

  it('metnin dilini sezer', () => {
    expect(speechLanguage('Bugün satışlar arttı.', 'en')).toBe('tr');
    expect(speechLanguage('The report is ready and you can open it.', 'tr')).toBe('en');
    expect(speechLanguage('Tamam', 'tr')).toBe('tr');
  });

  it('oyuncak sesleri değil, en doğal sesi seçer', () => {
    const voices = [
      voice('Albert', 'en-US', { default: true }),
      voice('Eddy (English (US))', 'en-US'),
      voice('Samantha', 'en-US'),
      voice('Ava (Premium)', 'en-US'),
      voice('Yelda', 'tr-TR'),
    ];
    expect(pickVoice(voices, 'en')?.name).toBe('Ava (Premium)');
    expect(pickVoice(voices.slice(0, 3), 'en')?.name).toBe('Samantha');
    expect(pickVoice(voices, 'tr')?.name).toBe('Yelda');
    expect(
      pickVoice([voice('Google Türkçe', 'tr-TR', { localService: false }), voice('Yelda', 'tr_TR')], 'tr')
        ?.name,
    ).toBe('Google Türkçe');
    expect(pickVoice(voices, 'tr')).toBeDefined();
    expect(pickVoice([voice('Anna', 'de-DE')], 'tr')).toBeUndefined();
  });

  it('hızı çubuğun aralığında ve yüzde bir hassasiyetle tutar', () => {
    expect(clampRate(0.837)).toBe(0.84);
    expect(clampRate(0.1)).toBe(0.5);
    expect(clampRate(5)).toBe(2);
    expect(clampRate(Number.NaN)).toBe(1);
  });
});
