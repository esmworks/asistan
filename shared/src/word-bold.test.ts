import { describe, expect, it } from 'vitest';
import { leftoverBold } from './word-bold';

describe('leftoverBold', () => {
  it('bolds a quoted word that a suffix follows', () => {
    expect(leftoverBold('Sonra **"Yenile"**ye bas, **"Kaldır"**a basma.')).toEqual([
      { text: 'Sonra ', bold: false },
      { text: '"Yenile"', bold: true },
      { text: 'ye bas, ', bold: false },
      { text: '"Kaldır"', bold: true },
      { text: 'a basma.', bold: false },
    ]);
  });

  it('leaves text without a pair alone', () => {
    expect(leftoverBold('2 ** 3 is eight')).toBeNull();
    expect(leftoverBold('a ** b ** c')).toBeNull();
    expect(leftoverBold('no stars')).toBeNull();
  });
});
