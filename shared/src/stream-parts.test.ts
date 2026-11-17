import { describe, expect, it } from 'vitest';
import { streamParts } from './stream-parts';

describe('streamParts', () => {
  it('kart yokken metnin tamamı yazılmaya devam eden tek parçadır', () => {
    expect(streamParts('Merhaba', [])).toEqual([{ kind: 'text', from: 0, text: 'Merhaba', live: true }]);
  });

  it('kartı sorulduğu yere, önceki metnin altına koyar', () => {
    expect(streamParts('Rapor hazır.', [{ card: 'q', at: 12 }])).toEqual([
      { kind: 'text', from: 0, text: 'Rapor hazır.', live: false },
      { kind: 'card', card: 'q' },
    ]);
  });

  it('cevaptan sonra gelen metni kartın altına yazar', () => {
    expect(streamParts('Önce. Sonra.', [{ card: 'q', at: 5 }])).toEqual([
      { kind: 'text', from: 0, text: 'Önce.', live: false },
      { kind: 'card', card: 'q' },
      { kind: 'text', from: 5, text: ' Sonra.', live: true },
    ]);
  });

  it('henüz bir şey yazılmadan sorulan kart metnin üstünde kalır', () => {
    expect(streamParts('Yazdım.', [{ card: 'q', at: 0 }])).toEqual([
      { kind: 'card', card: 'q' },
      { kind: 'text', from: 0, text: 'Yazdım.', live: true },
    ]);
  });

  it('kartları sorulma sırasıyla dizer, aynı noktadakileri geldikleri sırada bırakır', () => {
    const parts = streamParts('abcdef', [
      { card: 'c', at: 4 },
      { card: 'a', at: 2 },
      { card: 'b', at: 2 },
    ]);
    expect(parts.map((p) => (p.kind === 'card' ? p.card : p.text))).toEqual([
      'ab',
      'a',
      'b',
      'cd',
      'c',
      'ef',
    ]);
  });

  it('metinden uzun bir nokta metnin sonuna sayılır', () => {
    expect(streamParts('ab', [{ card: 'q', at: 10 }])).toEqual([
      { kind: 'text', from: 0, text: 'ab', live: false },
      { kind: 'card', card: 'q' },
    ]);
  });
});
