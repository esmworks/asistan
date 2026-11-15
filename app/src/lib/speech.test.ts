import { describe, expect, it } from 'vitest';
import { speakable } from './speech';

describe('sesli okuma', () => {
  it('Markdown işaretlerini ve kodu okumaz', () => {
    expect(
      speakable('## Özet\n\n- **Satış** arttı, [rapor](https://x.y) hazır.\n\n```js\nx()\n```\nBitti.'),
    ).toBe('Özet\n\nSatış arttı, rapor hazır.\n\n \nBitti.');
  });
});
