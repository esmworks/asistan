import { describe, expect, it } from 'vitest';
import { settingsMatch } from './settingsMatch';

describe('ayarlarda arama', () => {
  it('yazılan her sözcüğü adda ya da anahtar sözcüklerde arar', () => {
    expect(settingsMatch('', 'Genel')).toBe(true);
    expect(settingsMatch('koyu tema', 'Genel tema, koyu, açık')).toBe(true);
    expect(settingsMatch('İŞARET', 'işaret')).toBe(true);
    expect(settingsMatch('sinir', 'Kullanım sınır, bütçe')).toBe(true);
    expect(settingsMatch('webhook', 'Genel tema')).toBe(false);
  });
});
