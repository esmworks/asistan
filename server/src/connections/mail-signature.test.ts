import { describe, expect, it } from 'vitest';
import { inlinePictures } from './mail-signature';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe('inlinePictures', () => {
  it("puts the signature's pictures inside it, asked for over https", async () => {
    const asked: string[] = [];
    const html = await inlinePictures(
      '<b>Erhan</b><img src="https://example.com/logo.png?a=1&amp;b=2" width="100"><img src=\'http://example.com/x.png\'>',
      async (url) => {
        asked.push(url.href);
        return PNG;
      },
    );
    expect(asked.sort()).toEqual(['https://example.com/logo.png?a=1&b=2', 'https://example.com/x.png']);
    expect(html).toContain(`<img src="data:image/png;base64,${PNG.toString('base64')}" width="100">`);
    expect(html).toContain(`<img src='data:image/png;base64,`);
    expect(html).toContain('<b>Erhan</b>');
  });

  it('keeps the address of what is not a picture or cannot be fetched, and leaves data: alone', async () => {
    const html =
      '<img src="https://a.example/x.svg"><img src="https://b.example/y.png"><img src="data:image/gif;base64,R0lG">';
    const out = await inlinePictures(html, async (url) => {
      if (url.hostname === 'b.example') throw new Error('down');
      return Buffer.from('<svg/>');
    });
    expect(out).toBe(html);
  });
});
