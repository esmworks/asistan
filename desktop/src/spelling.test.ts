import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSpellingOn, spellingEntries, spellingLanguages, writeSpellingOn } from './spelling';

describe('spell checking', () => {
  it('is on until the person turns it off', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spelling-'));
    expect(readSpellingOn(dir)).toBe(true);
    writeSpellingOn(dir, false);
    expect(readSpellingOn(dir)).toBe(false);
    writeSpellingOn(dir, true);
    expect(readSpellingOn(dir)).toBe(true);
  });

  it("checks the person's languages it has a dictionary for, then Turkish and English", () => {
    const available = ['de-DE', 'en-GB', 'en-US', 'tr'];
    expect(spellingLanguages(['de-DE', 'fr-FR'], available)).toEqual(['de-DE', 'tr', 'en-US']);
    expect(spellingLanguages(['tr-TR'], available)).toEqual(['tr', 'en-US']);
    expect(spellingLanguages([], [])).toEqual([]);
  });

  it('offers at most five words for a misspelled one, or says none was found, and learning it', () => {
    const text = { none: 'none', learn: 'learn' };
    const many = ['a', 'b', 'c', 'd', 'e', 'f'];
    const entries = spellingEntries('mrhaba', many, text);
    expect(entries.filter((e) => e.replace)).toHaveLength(5);
    expect(entries.at(-1)).toEqual({ label: 'learn', learn: 'mrhaba' });
    expect(spellingEntries('xqz', [], text)[0]).toEqual({ label: 'none', enabled: false });
    expect(spellingEntries('', many, text)).toEqual([]);
  });
});
