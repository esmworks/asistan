import { describe, expect, it } from 'vitest';
import { translator } from '../src/i18n';
import { toResult } from '../src/services/connections';

const t = translator('en');

describe('bağlantı aracının yanıtı', () => {
  it('kısa yanıtı olduğu gibi verir', async () => {
    expect(await toResult({ content: [{ type: 'text', text: 'tamam' }] }, t)).toBe('tamam');
  });

  it('uzun yanıtı dosyada tutar, başını yoluyla birlikte verir', async () => {
    const long = 'x'.repeat(60_000);
    const kept: string[] = [];
    const out = (await toResult({ content: [{ type: 'text', text: long }] }, t, async (text) => {
      kept.push(text);
      return '/tmp/sonuc.txt';
    })) as string;
    expect(kept).toEqual([long]);
    expect(out.length).toBeLessThan(5_000);
    expect(out).toContain('/tmp/sonuc.txt');
    expect(out).toContain('60000');
  });

  it('dosyaya yazılamazsa eskisi gibi keser', async () => {
    const out = (await toResult({ content: [{ type: 'text', text: 'y'.repeat(30_000) }] }, t, async () => {
      throw new Error('disk dolu');
    })) as string;
    expect(out).toContain('[answer cut here]');
  });
});
