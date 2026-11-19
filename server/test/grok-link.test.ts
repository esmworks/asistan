import { grokTemplateId } from '@yumakbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseGrokTemplatePage, readGrokLink } from '../src/services/grok-link';
import { AUTH, testServer, type TestServer } from './helpers';

const ID = '93gOz3op1UQdBdbekQFLK';

/**
 * The share page as the site streams it: the card is JSON inside a JS string literal. `after`
 * stands for whatever the page sends next, such as other templates.
 */
const page = (card: Record<string, unknown>, after: unknown[] = []) => {
  const payload = `47:${JSON.stringify(['$', '$L60', null, { id: ID, ownerType: 'USER', ...card }, ...after])}\n`;
  return `<html><body><h1>x</h1><script>self.__next_f.push([1,${JSON.stringify('1:"$Sreact.fragment"\n')}])</script><script>self.__next_f.push([1,${JSON.stringify(payload)}])</script></body></html>`;
};

describe('Grok Bot paylaşım bağlantısı', () => {
  it('yalnızca x.ai/bot ve uygulamanın kendi adresindeki kimliği alır', () => {
    expect(grokTemplateId(`https://x.ai/bot/${ID}`)).toBe(ID);
    expect(grokTemplateId(` https://www.x.ai/bot/${ID}?ref=share `)).toBe(ID);
    expect(grokTemplateId(`grokbot://app/v1/bot-template?id=${ID}`)).toBe(ID);
    expect(grokTemplateId(`http://x.ai/bot/${ID}`)).toBeNull();
    expect(grokTemplateId(`https://x.ai.evil.net/bot/${ID}`)).toBeNull();
    expect(grokTemplateId(`https://x.ai/bot/${ID}/more`)).toBeNull();
    expect(grokTemplateId('https://x.ai/bot/../../etc')).toBeNull();
    expect(grokTemplateId('https://x.ai/bot/a%2Fb')).toBeNull();
    expect(grokTemplateId('not a link')).toBeNull();
  });

  it('sayfanın gösterdiği adı, paylaşanı ve açıklamayı okur', () => {
    const card = parseGrokTemplatePage(
      page({ sharerName: 'lauren 🎀', botName: 'dr "egg" bot', description: 'Designs bots.\nShort.' }),
      ID,
    );
    expect(card).toEqual({
      id: ID,
      name: 'dr "egg" bot',
      sharer: 'lauren 🎀',
      description: 'Designs bots.\nShort.',
    });
  });

  it('düzeni değişmiş ya da başka botun sayfasında alanları boş bırakır', () => {
    const empty = { id: ID, name: null, sharer: null, description: null };
    expect(parseGrokTemplatePage('<html></html>', ID)).toEqual(empty);
    expect(parseGrokTemplatePage(page({ botName: 'x' }), 'otherTemplateId1')).toMatchObject({
      name: null,
    });
  });

  it('şablonda olmayan alanı sonraki nesneden almaz', () => {
    const card = parseGrokTemplatePage(
      page({ botName: 'bos {aciklama}', description: null }, [
        { id: 'otherTemplateId1', botName: 'Other', description: 'Not this bot' },
      ]),
      ID,
    );
    expect(card).toMatchObject({ name: 'bos {aciklama}', description: null, sharer: null });
  });

  it('sayfaya ulaşılamazsa kartı yalnızca bağlantıyla verir', async () => {
    // A name that resolves to nothing: the fetch fails before any connection is made.
    const card = await readGrokLink(`https://x.ai/bot/${ID}`, { resolve: async () => [] });
    expect(card).toEqual({ id: ID, name: null, sharer: null, description: null });
  });

  it('uzun alanları kısaltır', () => {
    const card = parseGrokTemplatePage(page({ botName: 'n'.repeat(200), description: 'd'.repeat(900) }), ID);
    expect(card.name).toHaveLength(60);
    expect(card.description).toHaveLength(500);
  });

  describe('uç nokta', () => {
    let t: TestServer;
    beforeEach(async () => {
      t = await testServer();
    });
    afterEach(() => t.dispose());

    it('Grok bağlantısı olmayan adresi ağa çıkmadan reddeder', async () => {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/import/grok-link',
        headers: { ...AUTH, host: 'localhost' },
        payload: { url: 'https://example.com/bot/93gOz3op1UQdBdbekQFLK' },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
