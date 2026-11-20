import { describe, expect, it } from 'vitest';
import { BodyTooLarge, readCapped, readStart } from '../src/services/read-capped';
import {
  fetchPublicText,
  fetchSkillFile,
  privateAddress,
  publicLookup,
  skillFileUrl,
} from '../src/services/skill-link';

describe('bağlantıdan beceri', () => {
  it('GitHub sayfa bağlantısını ham dosya adresine çevirir', () => {
    expect(skillFileUrl('https://github.com/o/r/blob/main/skills/pdf/SKILL.md').href).toBe(
      'https://raw.githubusercontent.com/o/r/main/skills/pdf/SKILL.md',
    );
    expect(skillFileUrl('https://github.com/o/r/tree/main/skills/pdf').href).toBe(
      'https://raw.githubusercontent.com/o/r/main/skills/pdf/SKILL.md',
    );
    expect(skillFileUrl('https://github.com/o/r').href).toBe(
      'https://raw.githubusercontent.com/o/r/HEAD/SKILL.md',
    );
    expect(skillFileUrl('https://example.com/a.md').href).toBe('https://example.com/a.md');
    expect(() => skillFileUrl('http://example.com/a.md')).toThrow();
  });

  it('yerel ve özel ağ adreslerini tanır', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.5',
      '169.254.169.254',
      '::1',
      'fd00::1',
      '::ffff:127.0.0.1',
      '100.100.1.1',
    ])
      expect(privateAddress(ip)).toBe(true);
    for (const ip of ['140.82.112.3', '2606:4700::1111']) expect(privateAddress(ip)).toBe(false);
  });

  it('recognises private IPv4 hidden in IPv6 forms and reserved ranges', () => {
    for (const ip of [
      '2002:7f00:1::1',
      '64:ff9b::a9fe:a9fe',
      '::127.0.0.1',
      'fec0::1',
      'ff02::1',
      '198.18.0.1',
      '192.0.0.170',
      '240.0.0.1',
      '224.0.0.251',
    ])
      expect(privateAddress(ip), ip).toBe(true);
  });

  it('hands a connection only checked addresses, and refuses a name with any private one', async () => {
    const run = (addresses: string[], all: boolean) =>
      new Promise<{ err: Error | null; result: unknown }>((resolve) =>
        publicLookup(async () => addresses.map((address) => ({ address })))(
          'ornek.com',
          { all },
          (err, result) => resolve({ err, result }),
        ),
      );
    expect(await run(['140.82.112.3', '140.82.112.4'], true)).toEqual({
      err: null,
      result: [
        { address: '140.82.112.3', family: 4 },
        { address: '140.82.112.4', family: 4 },
      ],
    });
    expect((await run(['140.82.112.3'], false)).result).toBe('140.82.112.3');
    // The first address is public, a later one is not: the connection could use either.
    expect((await run(['140.82.112.3', '10.0.0.5'], true)).err).toBeInstanceOf(Error);
    expect((await run([], true)).err).toBeInstanceOf(Error);
  });

  it('refuses a page whose name resolves to a private address among public ones', async () => {
    const resolve = async () => [{ address: '140.82.112.3' }, { address: '127.0.0.1' }];
    await expect(fetchPublicText(new URL('https://ornek.com/a.md'), 1024, { resolve })).rejects.toMatchObject(
      {
        status: 400,
        key: 'error.skillLinkPrivate',
      },
    );
    await expect(fetchPublicText(new URL('https://[::ffff:7f00:1]/a.md'))).rejects.toMatchObject({
      key: 'error.skillLinkPrivate',
    });
  });

  it('reads a body no further than the limit, with or without a size header', async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 1024;
        c.enqueue(new Uint8Array(1024));
      },
    });
    await expect(readCapped(endless, 10 * 1024)).rejects.toBeInstanceOf(BodyTooLarge);
    expect(pulled).toBeLessThan(20 * 1024);
    expect((await readCapped(new Response('kısa').body, 100)).toString()).toBe('kısa');
  });

  it('reads only the start of a body when that is all that is wanted', async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 1024;
        c.enqueue(new Uint8Array(1024).fill(65));
      },
    });
    expect((await readStart(endless, 1500)).length).toBe(1500);
    expect(pulled).toBeLessThan(5 * 1024);
    expect((await readStart(new Response('kısa').body, 100)).toString()).toBe('kısa');
  });

  it('yerel adrese giden bağlantıyı reddeder', async () => {
    await expect(fetchSkillFile('https://localhost/SKILL.md')).rejects.toMatchObject({ status: 400 });
    await expect(fetchSkillFile('bir şey')).rejects.toMatchObject({ status: 400 });
  });
});
