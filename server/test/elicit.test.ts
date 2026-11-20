import { describe, expect, it } from 'vitest';
import { elicitContent, elicitQuestions } from '../src/connections/elicit';

const form = {
  message: 'Proje bilgisi gerekiyor',
  requestedSchema: {
    properties: {
      name: { type: 'string', title: 'Proje adı' },
      size: { type: 'integer', title: 'Kişi sayısı', description: 'Ekipteki kişi' },
      public: { type: 'boolean', title: 'Herkese açık mı' },
      region: {
        type: 'string',
        oneOf: [
          { const: 'eu', title: 'Avrupa' },
          { const: 'us', title: 'Amerika' },
        ],
      },
      tags: { type: 'array', items: { enum: ['a', 'b', 'c'] } },
    },
    required: ['name', 'public'],
  },
};

describe('MCP sunucusunun sorusu', () => {
  it('alanları karttaki sorulara çevirir', () => {
    const qs = elicitQuestions(form, ['Evet', 'Hayır']);
    expect(qs.map((q) => [q.key, q.question, q.options, q.required])).toEqual([
      ['name', 'Proje adı', [], true],
      ['size', 'Kişi sayısı — Ekipteki kişi', [], false],
      ['public', 'Herkese açık mı', ['Evet', 'Hayır'], true],
      ['region', 'region', ['Avrupa', 'Amerika'], false],
      ['tags', 'tags', ['a', 'b', 'c'], false],
    ]);
  });

  it('cevapları istenen türde geri verir; zorunlusu boşsa ya da türü tutmazsa reddeder', () => {
    const qs = elicitQuestions(form, ['Evet', 'Hayır']);
    expect(elicitContent(qs, ['LeafBot', '4', 'Hayır', 'Avrupa', 'a, c'])).toEqual({
      name: 'LeafBot',
      size: 4,
      public: false,
      region: 'eu',
      tags: ['a', 'c'],
    });
    expect(elicitContent(qs, ['LeafBot', '', 'Evet', '', ''])).toEqual({ name: 'LeafBot', public: true });
    expect(elicitContent(qs, ['', '', 'Evet'])).toBeNull();
    expect(elicitContent(qs, ['LeafBot', 'dört', 'Evet'])).toBeNull();
    expect(elicitContent(qs, ['LeafBot', '4.5', 'Evet'])).toBeNull();
  });
});
