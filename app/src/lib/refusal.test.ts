import { describe, expect, it } from 'vitest';
import { isRefusal } from './refusal';

describe('geri çeviren seçenek', () => {
  it('hayır, iptal ve benzerlerini tanır; olumlu ya da sıradan seçenekleri tanımaz', () => {
    for (const no of ['Hayır', 'İptal', 'Şimdilik değil', 'Hayır, teşekkürler', 'No', 'Cancel', 'Not now.']) {
      expect(isRefusal(no)).toBe(true);
    }
    for (const yes of ['Evet', 'Kasım', 'Nohut', 'Notlara ekle', 'Yes', 'Nothing else', 'Aralık']) {
      expect(isRefusal(yes)).toBe(false);
    }
  });
});
