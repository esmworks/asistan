import { describe, expect, it } from 'vitest';
import { highlight } from './highlight';

describe('kod renklendirme', () => {
  it('bilinen dili açık ve koyu tema renkleriyle jetonlara ayırır', async () => {
    const lines = await highlight('const a = 1;\nconst b = "x";', 'ts');
    expect(lines).toHaveLength(2);
    expect(lines![0]!.map((t) => t.content).join('')).toBe('const a = 1;');
    expect(lines![0]![0]!.htmlStyle?.['--shiki-dark']).toBeTruthy();
  });

  it('bilinmeyen dili ve çok uzun kodu renklendirmez', async () => {
    expect(await highlight('x', 'dilyok')).toBeNull();
    expect(await highlight('a'.repeat(30_000), 'ts')).toBeNull();
  });
});
