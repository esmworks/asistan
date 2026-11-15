import { describe, expect, it } from 'vitest';
import { findOffsets, findRanges } from './findText';

describe('sohbette bul', () => {
  it('büyük küçük harfe bakmadan bulur, Türkçe İ/ı dahil', () => {
    expect(findOffsets('İstanbul ve istanbul', 'istanbul')).toEqual([
      [0, 8],
      [12, 20],
    ]);
    expect(findOffsets('KIRMIZI', 'kırmızı')).toEqual([[0, 7]]);
  });

  it('aradaki boşluk ve satır sonlarını tek boşluk sayar', () => {
    expect(findOffsets('toplantı\n  notları', 'toplantı notları')).toEqual([[0, 18]]);
  });

  it('düzenli ifade karakterlerini harfiyen arar', () => {
    expect(findOffsets('fiyat (KDV dahil) 1.5$', '(kdv')).toEqual([[6, 10]]);
    expect(findOffsets('a.b', 'a.c')).toEqual([]);
  });

  it('sayfadaki metin düğümlerinde aralık üretir', () => {
    const div = document.createElement('div');
    div.innerHTML = '<p>Rapor hazır</p><p>Yeni rapor</p>';
    expect(findRanges(div, 'rapor').map((r) => r.toString())).toEqual(['Rapor', 'rapor']);
  });
});
