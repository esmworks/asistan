import { describe, expect, it } from 'vitest';
import { pickSkill, skillQuery } from './skillTag';

describe('skillTag', () => {
  it('imlecin hemen önünde yazılan $adı bulur', () => {
    expect(skillQuery('$fat', 4)).toEqual({ start: 0, query: 'fat' });
    expect(skillQuery('bunu $ ile', 6)).toEqual({ start: 5, query: '' });
    expect(skillQuery('fiyat a$5', 9)).toBeNull();
    expect(skillQuery('$fatura bitti', 13)).toBeNull();
  });

  it('seçilen beceri yazılan parçanın yerine geçer ve imleç sonrasına gider', () => {
    expect(pickSkill('şunu $fa', 8, 'fatura')).toEqual({ text: 'şunu $fatura ', caret: 13 });
    expect(pickSkill('$fa ile kes', 3, 'fatura')).toEqual({ text: '$fatura ile kes', caret: 8 });
  });
});
