import { describe, expect, it } from 'vitest';
import { goalCommand, slashMatches, slashQuery } from './slash';

describe('eğik çizgi komutları', () => {
  it('yalnız tüm metin /ad iken komut arar', () => {
    expect(slashQuery('/')).toBe('');
    expect(slashQuery('/Yeni')).toBe('yeni');
    expect(slashQuery('/etc/hosts')).toBeNull();
    expect(slashQuery('/new bir şey')).toBeNull();
    expect(slashQuery('merhaba /new')).toBeNull();
  });

  it('adla ya da etiketin sözcükleriyle eşleşir, adı baştan tutanlar önce gelir', () => {
    const label = (c: string) => ({ new: 'Yeni sohbet', find: 'Sohbette bul' })[c] ?? c;
    expect(slashMatches('', label).length).toBeGreaterThan(3);
    expect(slashMatches('f', label)[0]).toBe('find');
    expect(slashMatches('sohbet', label)).toEqual(['new', 'find']);
    expect(slashMatches('', label, (c) => c !== 'stop')).not.toContain('stop');
  });
});

describe('hedef komutu', () => {
  it('/goal ile hedefi ayırır, boş hedef kaldırır', () => {
    expect(goalCommand('/goal Cuma günü raporu bitir')).toBe('Cuma günü raporu bitir');
    expect(goalCommand('/goal\nçok satırlı\nhedef')).toBe('çok satırlı\nhedef');
    expect(goalCommand('/goal')).toBe('');
    expect(goalCommand('/goalkeeper')).toBeNull();
    expect(goalCommand('hedef /goal x')).toBeNull();
  });
});
