import { describe, expect, it } from 'vitest';
import { parseSkillFile, skillSlug } from './skill';

describe('beceri dosyası', () => {
  it('ön bilgiden ad ve açıklamayı, gerisini gövde olarak alır', () => {
    const f = parseSkillFile(
      '---\nname: weekly-report\ndescription: "Writes the weekly report"\nlicense: MIT\n---\n\n# Weekly report\n\nSteps…\n',
    );
    expect(f).toEqual({
      name: 'weekly-report',
      description: 'Writes the weekly report',
      body: '# Weekly report\n\nSteps…',
    });
  });

  it('çok satırlı açıklamayı birleştirir', () => {
    const f = parseSkillFile(
      '---\nname: pdf\ndescription: >\n  Fill PDF forms\n  and merge files\n---\nBody',
    );
    expect(f.description).toBe('Fill PDF forms and merge files');
  });

  it('ön bilgisi olmayan dosyada adı dosya adından, açıklamayı ilk satırdan alır', () => {
    const f = parseSkillFile('# Fatura Hazırlama\nAdımlar', 'Fatura Hazırlama.md');
    expect(f.name).toBe('fatura-hazirlama');
    expect(f.description).toBe('Fatura Hazırlama');
  });

  it('adı küçük harf ve tirelere çevirir', () => {
    expect(skillSlug('  Haftalık Rapor!! ')).toBe('haftalik-rapor');
    expect(skillSlug('Çok Şık Ödev')).toBe('cok-sik-odev');
  });
});
