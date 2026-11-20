import type { Message, Thread, UsageReport } from '@yumakbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseOffer } from '../src/services/offers';
import { testServer, type TestServer } from './helpers';

describe('work offers', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const OFFER = JSON.stringify({
    offer: 'Faturayı itiraz e-postası taslağına çevireyim mi?',
    task: 'Bu fatura için bir itiraz e-postası taslağı hazırla, gönderme.',
  });
  const isOffer = (system: string) => system.includes('{"offer":null}');
  const thread = async (botId: string) =>
    (await t.api<Thread>('POST', `/api/bots/${botId}/threads`, {})).body;
  const settle = async () => {
    await t.services.turns.idle();
    await t.services.offers.idle();
  };
  const offers = async (threadId: string) =>
    (await t.messages(threadId)).filter((m) => m.props.kind === 'offer');

  it('reads the answer only as a whole offer', () => {
    expect(parseOffer(OFFER)).toMatchObject({ task: expect.stringContaining('itiraz') });
    expect(parseOffer('{"offer":null}')).toBeNull();
    expect(parseOffer('{"offer":"", "task":"x"}')).toBeNull();
    expect(parseOffer('no json here')).toBeNull();
  });

  it('looks only when the person turned it on', async () => {
    t.engine.completer = (req) => (isOffer(req.system) ? OFFER : '{"operations":[]}');
    const bot = await t.bot();
    const th = await thread(bot.id);
    await t.send(th.id, 'geçen ayın faturasında bir yanlışlık var');
    await settle();
    expect(t.engine.completions.filter((r) => isOffer(r.system))).toEqual([]);
    expect(await offers(th.id)).toEqual([]);
  });

  it('offers once after an answer; taking it sends the task as the person, and it is answered once', async () => {
    await t.api('PATCH', '/api/settings', { workOffers: true });
    t.engine.completer = (req) => (isOffer(req.system) ? OFFER : '{"operations":[]}');
    const bot = await t.bot();
    const th = await thread(bot.id);
    await t.send(th.id, 'geçen ayın faturasında bir yanlışlık var');
    await settle();
    const [card] = await offers(th.id);
    expect(card).toMatchObject({ role: 'system', text: expect.stringContaining('itiraz') });
    // What was said reached the model as data, not as instructions.
    const asked = t.engine.completions.filter((r) => isOffer(r.system));
    expect(asked).toHaveLength(1);
    expect(asked[0]!.user).toContain('faturasında');

    const taken = await t.api<Message>('POST', `/api/messages/${card!.id}/offer`, { take: true });
    expect(taken.body.props.answer).toBe('taken');
    await settle();
    const msgs = await t.messages(th.id);
    expect(msgs.some((m) => m.role === 'user' && m.text.includes('itiraz e-postası taslağı'))).toBe(true);
    expect((await t.api('POST', `/api/messages/${card!.id}/offer`, { take: false })).status).toBe(409);

    // Soon after, the same conversation is not looked at again.
    await t.send(th.id, 'teşekkürler');
    await settle();
    expect(t.engine.completions.filter((r) => isOffer(r.system))).toHaveLength(1);

    const usage = (await t.api<UsageReport>('GET', '/api/usage?days=7')).body;
    expect(usage.offers).toMatchObject({ checks: 1, found: 1 });
  });

  it('turning an offer down only marks the card; a look with nothing to offer leaves no card', async () => {
    await t.api('PATCH', '/api/settings', { workOffers: true });
    t.engine.completer = (req) => (isOffer(req.system) ? OFFER : '{"operations":[]}');
    const bot = await t.bot();
    const th = await thread(bot.id);
    await t.send(th.id, 'faturamda yanlışlık var');
    await settle();
    const [card] = await offers(th.id);
    const before = (await t.messages(th.id)).length;
    const declined = await t.api<Message>('POST', `/api/messages/${card!.id}/offer`, { take: false });
    expect(declined.body.props.answer).toBe('declined');
    await settle();
    expect((await t.messages(th.id)).length).toBe(before);

    t.engine.completer = (req) => (isOffer(req.system) ? '{"offer":null}' : '{"operations":[]}');
    const other = await thread(bot.id);
    await t.send(other.id, 'merhaba');
    await settle();
    expect(await offers(other.id)).toEqual([]);
  });
});
