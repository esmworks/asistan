import { describe, expect, it } from 'vitest';
import { toCsv, toMarkdown } from './tableCopy';

describe('tablo kopyalama', () => {
  const rows = [
    ['Ürün', 'Fiyat'],
    ['Kalem, mavi', '5'],
    ['Defter "A4"', '12|3'],
  ];
  it('Markdown olarak yazar', () => {
    expect(toMarkdown(rows)).toBe(
      '| Ürün | Fiyat |\n| --- | --- |\n| Kalem, mavi | 5 |\n| Defter "A4" | 12\\|3 |',
    );
  });
  it('CSV olarak yazar, gereken hücreleri tırnaklar', () => {
    expect(toCsv(rows)).toBe('Ürün,Fiyat\r\n"Kalem, mavi",5\r\n"Defter ""A4""",12|3');
  });
});
