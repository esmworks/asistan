import { describe, expect, it } from 'vitest';
import { plainText, quoteExcerpt, titleFrom } from './quote';

describe('quote', () => {
  it('reduces a Markdown table, heading and emphasis to their words', () => {
    const md = '## Ciro\n\n| Dönem | TL |\n| --- | ---: |\n| **11.11** resmi | 24.680,24 |';
    expect(plainText(md)).toBe('Ciro Dönem TL 11.11 resmi 24.680,24');
  });

  it('keeps the words of links, list items and inline code', () => {
    expect(plainText('- see [the report](https://x.y/r) and `npm test`\n1. done')).toBe(
      'see the report and npm test done',
    );
  });

  it('keeps snake_case and lone asterisks', () => {
    expect(plainText('use send_file with 2 * 3')).toBe('use send_file with 2 * 3');
  });

  it('cuts a long message on a word and marks the cut', () => {
    const q = quoteExcerpt('word '.repeat(100), 22);
    expect(q).toBe('word word word word…');
    expect(quoteExcerpt('short')).toBe('short');
  });
});

describe('sohbet adı', () => {
  it('ilk sözcüklü satırdan, işaretsiz ve sözcükte keserek ad verir', () => {
    expect(titleFrom('\n## **Kira** sözleşmesi\nayrıntılar')).toBe('Kira sözleşmesi');
    expect(
      titleFrom('Bu çok uzun bir ilk mesaj, sohbetin adına sığmayacak kadar çok sözcük içeriyor aslında', 40),
    ).toBe('Bu çok uzun bir ilk mesaj, sohbetin…');
    expect(titleFrom('```\n```')).toBe('');
  });

  it('boşluksuz metni bir emojinin ortasından kesmez', () => {
    const title = titleFrom(`${'a'.repeat(59)}😀😀`, 60);
    expect(title).toBe(`${'a'.repeat(59)}…`);
    expect(/[\uD800-\uDBFF]$/.test(title.slice(0, -1))).toBe(false);
  });
});
