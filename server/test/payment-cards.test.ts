import type { PaymentCard } from '@yumakbot/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { testServer, type Person, type TestServer } from './helpers';

// Published test card numbers only; never a real card.
const VISA = '4242424242424242';
const AMEX = '378282246310005';

describe('ödeme kartları', () => {
  let t: TestServer;
  let ayse: Person;
  let mehmet: Person;
  beforeEach(async () => {
    t = await testServer();
    ayse = await t.person('ayse');
    mehmet = await t.person('mehmet');
  });
  afterEach(() => t.dispose());
  const db = () => t.services.ctx.db;

  it('kartı mühürler; numarayı, kodu ve adı hiç geri vermez; başkası göremez', async () => {
    const made = await ayse.api<PaymentCard>('POST', '/api/cards', {
      label: 'Kişisel',
      number: VISA,
      expMonth: '3',
      expYear: '2031',
      cvc: '321',
      holder: 'Ayşe Yılmaz',
    });
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({
      brand: 'visa',
      last4: '4242',
      expMonth: 3,
      expYear: 2031,
      userId: 'ayse',
    });
    const all = JSON.stringify((await ayse.api('GET', '/api/cards')).body);
    for (const secret of [VISA, '321', 'Yılmaz']) expect(all).not.toContain(secret);
    const [row] = await db()
      .select()
      .from(schema.paymentCards)
      .where(eq(schema.paymentCards.id, made.body.id));
    expect(row!.secret.startsWith('v2:')).toBe(true);
    expect(row!.secret).not.toContain(VISA);

    // Someone else's card is neither listed nor changed.
    expect((await mehmet.api<PaymentCard[]>('GET', '/api/cards')).body).toEqual([]);
    expect((await mehmet.api('PATCH', `/api/cards/${made.body.id}`, { label: 'x' })).status).toBe(404);
    expect((await mehmet.api('DELETE', `/api/cards/${made.body.id}`)).status).toBe(404);
    // Only those who look after the server add a card for the whole team.
    expect(
      (await ayse.api('POST', '/api/cards', { number: AMEX, expMonth: 1, expYear: 30, team: true })).status,
    ).toBe(403);
    // A number that fails its check digit, or a code of the wrong length, is refused.
    expect(
      (await ayse.api('POST', '/api/cards', { number: '4242424242424241', expMonth: 1, expYear: 30 })).status,
    ).toBe(400);
    expect(
      (await ayse.api('POST', '/api/cards', { number: VISA, expMonth: 1, expYear: 30, cvc: '12' })).status,
    ).toBe(400);
  });

  it('bot kartı yalnız sahibi için ve seçilen botlarla açar; onaylı siteler satıra bağlıdır', async () => {
    const bot = await t.bot({ name: 'Alışveriş' });
    const other = await t.bot({ name: 'Başka' });
    const cards = t.services.cards;
    const mine = (
      await ayse.api<PaymentCard>('POST', '/api/cards', { number: VISA, expMonth: 1, expYear: 2040 })
    ).body;
    const team = (
      await t.api<PaymentCard>('POST', '/api/cards', {
        number: AMEX,
        expMonth: 1,
        expYear: 2040,
        team: true,
        botIds: [bot.id],
      })
    ).body;
    expect(team.userId).toBeNull();
    expect(mine.hasCvc).toBe(false);

    expect((await cards.forBot(bot.id, 'ayse')).map((c) => c.last4)).toEqual(['4242', '0005']);
    expect((await cards.forBot(other.id, 'ayse')).map((c) => c.last4)).toEqual(['4242']);
    expect((await cards.forBot(bot.id, 'mehmet')).map((c) => c.last4)).toEqual(['0005']);
    expect((await cards.forBot(bot.id, 'ayse'))[0]!.number).toBe(VISA);

    await cards.allowSite(mine.id, 'magaza.example');
    await cards.allowSite(mine.id, 'kitap.example');
    expect((await cards.get(mine.id)).sites).toEqual(['kitap.example', 'magaza.example']);
    // Sites can only be taken back through the app, not added.
    const after = await ayse.api<PaymentCard>('PATCH', `/api/cards/${mine.id}`, {
      forgetSites: ['kitap.example'],
      cvc: '111',
    });
    expect(after.body).toMatchObject({ sites: ['magaza.example'], hasCvc: true });
    // Copied to another row in the database, the approved sites do not open there.
    const [row] = await db().select().from(schema.paymentCards).where(eq(schema.paymentCards.id, mine.id));
    await db()
      .update(schema.paymentCards)
      .set({ sites: row!.sites })
      .where(eq(schema.paymentCards.id, team.id));
    expect((await cards.get(team.id)).sites).toEqual([]);
    // Nor does a number moved to another row: that card is left out.
    await db()
      .update(schema.paymentCards)
      .set({ secret: row!.secret })
      .where(eq(schema.paymentCards.id, team.id));
    expect((await cards.forBot(bot.id, 'mehmet')).map((c) => c.last4)).toEqual([]);
    // Listing does not open the sealed values: whether a code is kept is a column of its own.
    expect((await cards.get(team.id)).hasCvc).toBe(false);
    expect((await ayse.api<PaymentCard>('PATCH', `/api/cards/${mine.id}`, { cvc: '' })).body.hasCvc).toBe(
      false,
    );

    // A bot that is deleted leaves the list of those a card is kept for.
    await t.api('POST', `/api/bots/${bot.id}/archive`);
    await t.api('DELETE', `/api/bots/${bot.id}`);
    expect((await cards.get(team.id)).botIds).toEqual([]);
  });
});
