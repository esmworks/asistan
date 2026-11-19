import { MAX_MINUTES_ITEMS } from '@yumakbot/shared';
import { describe, expect, it } from 'vitest';
import { fits, LINE_MAX, lines, oneLine } from './minutes';

describe('tutanak satırları', () => {
  it('yalnızca madde işaretini siler, eksi işaretini korur', () => {
    expect(lines('- Bütçe onaylandı\n• Lansman 1 Aralık\n* Duyuru\n-5% indirim\n\n  ')).toEqual([
      'Bütçe onaylandı',
      'Lansman 1 Aralık',
      'Duyuru',
      '-5% indirim',
    ]);
  });

  it('satır kırığı olan bir karar düzenleyicide tek satır kalır', () => {
    const text = oneLine(['Lansman 1 Aralık’ta,\nduyuru önce listeye', 'Bütçe 10 bin']);
    expect(lines(text)).toEqual(['Lansman 1 Aralık’ta, duyuru önce listeye', 'Bütçe 10 bin']);
  });

  it('sunucunun sınırlarını aşan liste kabul edilmez', () => {
    expect(fits(['kısa'])).toBe(true);
    expect(fits(['x'.repeat(LINE_MAX + 1)])).toBe(false);
    expect(fits(Array.from({ length: MAX_MINUTES_ITEMS + 1 }, (_, i) => `${i}`))).toBe(false);
  });
});
