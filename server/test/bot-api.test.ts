import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTH, testServer, type TestServer } from './helpers';

describe('bot API', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const ask = (botId: string, payload: object) =>
    t.app.inject({ method: 'POST', url: `/api/bots/${botId}/ask`, headers: AUTH, payload });

  it('anahtarla gelen mesajı kendi sohbetinde yanıtlar ve yanıtı döndürür', async () => {
    const bot = await t.bot();
    const first = await ask(bot.id, { text: 'merhaba' });
    expect(first.statusCode).toBe(200);
    const body = first.json() as { status: string; reply: string; threadId: string; turnId: string };
    expect(body.status).toBe('done');
    expect(body.reply).toContain('merhaba');
    // The same API conversation is used again; the main chat is left alone.
    const second = (await ask(bot.id, { text: 'tekrar' })).json() as { threadId: string };
    expect(second.threadId).toBe(body.threadId);
    const main = (await t.api<{ id: string }>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    expect(main.id).not.toBe(body.threadId);
    const again = await t.app.inject({
      method: 'GET',
      url: `/api/turns/${body.turnId}/result`,
      headers: AUTH,
    });
    expect(again.json()).toMatchObject({ status: 'done', turnId: body.turnId });
  });

  it('bekleme süresi dolunca turun kimliğiyle 202 döner; anahtarsız istek reddedilir', async () => {
    const bot = await t.bot();
    const slow = await ask(bot.id, { text: '[bekle:3000] yavaş', wait: 0 });
    expect(slow.statusCode).toBe(202);
    expect(slow.json()).toMatchObject({ status: 'running' });
    await t.services.turns.idle();
    const none = await t.app.inject({
      method: 'POST',
      url: `/api/bots/${bot.id}/ask`,
      headers: { host: 'localhost' },
      payload: { text: 'x' },
    });
    expect(none.statusCode).toBe(401);
  });
});
