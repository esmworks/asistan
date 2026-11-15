import { describe, expect, it } from 'vitest';
import { libraryKey, localFilePath, localFolderPath } from './fileLink';

describe('dosya bağlantıları', () => {
  const base = 'bots/b1/threads/t1';
  it('göreli yolu sohbet klasöründen, mutlak yolu olduğu gibi alır', () => {
    expect(localFilePath('rapor.md', base)).toBe('bots/b1/threads/t1/rapor.md');
    expect(localFilePath('./out/a.csv', base)).toBe('bots/b1/threads/t1/out/a.csv');
    expect(localFilePath('../../files/not.txt', base)).toBe('bots/b1/files/not.txt');
    expect(localFilePath('/data/workspaces/bots/b1/files/x.pdf', base)).toBe(
      '/data/workspaces/bots/b1/files/x.pdf',
    );
    expect(localFilePath('file:///tmp/a%20b.txt', base)).toBe('/tmp/a b.txt');
    expect(localFilePath('src/page.tsx:12', base)).toBe('bots/b1/threads/t1/src/page.tsx');
  });

  it('web adreslerini ve dosya olmayanları bırakır', () => {
    for (const href of [
      'https://ornek.com/a.md',
      'mailto:a@b.c',
      '#bolum',
      '//cdn.x/y',
      '~/x.txt',
      'klasor/',
    ])
      expect(localFilePath(href, base)).toBeNull();
  });
});

describe('klasör bağlantısı', () => {
  it('sonu / ile biten bağlantıyı klasör yolu olarak okur', () => {
    expect(localFolderPath('raporlar/', 'bots/b/threads/t')).toBe('bots/b/threads/t/raporlar');
    expect(localFolderPath('raporlar', 'bots/b/threads/t')).toBeNull();
    expect(localFolderPath('https://ornek.com/a/', 'bots/b/threads/t')).toBeNull();
  });
  it('mutlak yolu dosya listesinin biçimine çevirir', () => {
    expect(libraryKey('/data/workspaces/bots/b/files/raporlar')).toBe('bots/b/files/raporlar');
    expect(libraryKey('bots/b/threads/t/x')).toBe('bots/b/threads/t/x');
  });
});
