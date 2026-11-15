import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { uniqueName, zip } from '../src/zip';

/** Reads the archive back through its central directory, as an unzip program does. */
function unzip(buf: Buffer): Record<string, string> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(at)).toBe(0x02014b50);
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26);
    const body = buf.subarray(start, start + size);
    out[name] = (method === 8 ? inflateRawSync(body) : body).toString('utf8');
    at += 46 + nameLen;
  }
  return out;
}

describe('zip', () => {
  it('dosyaları sıkıştırarak ya da olduğu gibi yazar; Türkçe adları korur', () => {
    const now = new Date('2026-11-16T10:00:00');
    const archive = zip([
      { name: 'rapor.txt', data: Buffer.from('a'.repeat(1000)), modifiedAt: now },
      { name: 'kısa.md', data: Buffer.from('x'), modifiedAt: now },
    ]);
    expect(unzip(archive)).toEqual({ 'rapor.txt': 'a'.repeat(1000), 'kısa.md': 'x' });
  });

  it('sistemdeki unzip ile açılır', (ctx) => {
    let ok = true;
    try {
      execFileSync('python3', ['-c', 'import zipfile']);
    } catch {
      ok = false;
    }
    if (!ok) return ctx.skip();
    const dir = mkdtempSync(join(tmpdir(), 'yumakbot-zip-'));
    try {
      const file = join(dir, 'a.zip');
      writeFileSync(file, zip([{ name: 'ç.txt', data: Buffer.from('merhaba'), modifiedAt: new Date() }]));
      const out = execFileSync('python3', [
        '-I',
        '-c',
        'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(z.read("ç.txt").decode())',
        file,
      ]).toString();
      expect(out.trim()).toBe('merhaba');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('aynı adları numaralar', () => {
    const taken = new Set(['a.txt', 'a (2).txt']);
    expect(uniqueName('a.txt', taken)).toBe('a (3).txt');
    expect(uniqueName('b', new Set(['b']))).toBe('b (2)');
  });
});
