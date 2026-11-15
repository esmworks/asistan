import { describe, expect, it } from 'vitest';
import { continueList } from './listContinue';

describe('liste sürdürme', () => {
  it('sonraki maddeyi açar; numarayı artırır, girintiyi korur', () => {
    expect(continueList('- süt', 5)).toEqual({ text: '- süt\n- ', caret: 8 });
    expect(continueList('Liste:\n1. bir', 13)).toEqual({ text: 'Liste:\n1. bir\n2. ', caret: 17 });
    expect(continueList('  * iç', 6)).toEqual({ text: '  * iç\n  * ', caret: 11 });
  });

  it('boş madde listeyi bitirir; liste dışında ve satır ortasında bir şey yapmaz', () => {
    expect(continueList('- süt\n- ', 8)).toEqual({ text: '- süt\n', caret: 6 });
    expect(continueList('merhaba', 7)).toBeNull();
    expect(continueList('- süt', 3)).toBeNull();
    expect(continueList('-süt', 4)).toBeNull();
  });

  it('araya giren numaralı maddeden sonra alttakileri yeniden numaralar', () => {
    const text = '1. bir\n2. iki\n   - alt\n3. üç\n\nson 4. değil';
    const next = continueList(text, 6)!;
    expect(next.text).toBe('1. bir\n2. \n3. iki\n   - alt\n4. üç\n\nson 4. değil');
    expect(next.caret).toBe(10);
  });
});
