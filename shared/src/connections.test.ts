import { describe, expect, it } from 'vitest';
import { formHeaders } from './connections';

describe('yeni bağlantı formunun başlıkları', () => {
  it('eklenenlere yazılı ama eklenmemiş başlığı da katar; aynı ad büyük-küçük harf farkıyla bir kez gider', () => {
    const added = [
      { name: 'X-Api-Key', value: 'eski' },
      { name: 'X-Team', value: 'ekip' },
    ];
    expect(formHeaders(added, { name: ' x-api-key ', value: 'yeni' })).toEqual([
      { name: 'x-api-key', value: 'yeni' },
      { name: 'X-Team', value: 'ekip' },
    ]);
  });

  it('adı ya da değeri boş olanı göndermez', () => {
    expect(formHeaders([], { name: 'X-Api-Key', value: '' })).toEqual([]);
    expect(formHeaders([], { name: '  ', value: 'deger' })).toEqual([]);
  });
});
