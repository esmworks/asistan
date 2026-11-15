import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv';

describe('CSV', () => {
  it('tırnaklı alanları, içindeki ayırıcıyı ve satır sonunu okur', () => {
    const text = ['ad,not', 'Ali,"merhaba, dünya"', '"Ayşe","çok', 'satır ""alıntı"""', ''].join('\r\n');
    expect(parseCsv(text)).toEqual([
      ['ad', 'not'],
      ['Ali', 'merhaba, dünya'],
      ['Ayşe', 'çok\r\nsatır "alıntı"'],
    ]);
  });

  it('noktalı virgül ve sekme ayırıcısını tanır', () => {
    expect(parseCsv('a;b;c\n1;2,5;3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2,5', '3'],
    ]);
    expect(parseCsv('a\tb\n1\t2', true)).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});
