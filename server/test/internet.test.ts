import type { Approval, Thread } from '@yumakbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { publicHost } from '../src/services/skill-link';
import { testServer, waitFor, type TestServer } from './helpers';

describe('genel adres', () => {
  it('bu bilgisayarı ve yerel ağı genel saymaz', async () => {
    for (const host of ['localhost', 'app.localhost', '127.0.0.1', '10.0.0.5', '192.168.1.1', '[::1]', ''])
      expect(await publicHost(host), host).toBe(false);
    expect(await publicHost('93.184.215.14')).toBe(true);
  });
});

describe('internet anahtarı', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const reply = async (threadId: string, text: string) => {
    await t.send(threadId, text);
    await t.services.turns.idle();
    return (await t.messages(threadId)).at(-1)!.text;
  };
  const pending = async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body;

  it('açıkken komutların genel sitelere çıkışına ve web okumaya kart sormadan izin verir', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    const text = await reply(
      thread.id,
      '[izin:SandboxNetworkAccess {"host":"93.184.215.14"}] [izin:WebSearch {"query":"hava"}] [izin:WebFetch {"url":"https://93.184.215.14/"}]',
    );
    expect(text).toContain('SandboxNetworkAccess: izin verildi');
    expect(text).toContain('WebSearch: izin verildi');
    expect(text).toContain('WebFetch: izin verildi');
    expect(await pending()).toHaveLength(0);
    expect(t.engine.requests.at(-1)!.sandbox.internet).toBe(true);
  });

  it('bu bilgisayardaki ya da yerel ağdaki sayfayı okumak izin kipine göre sorulur', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, '[izin:WebFetch {"url":"http://127.0.0.1:4319/api/bots"}]');
    const card = await waitFor(async () => (await pending())[0]);
    expect(card.toolName).toBe('WebFetch');
    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'deny' });
    await t.services.turns.idle();
    expect((await t.messages(thread.id)).at(-1)!.text).toContain('WebFetch: reddedildi');
  });

  it('açıkken bile bu bilgisayara ve yerel ağa çıkışı reddeder', async () => {
    const bot = await t.bot({ permissionMode: 'auto' });
    const text = await reply(
      (await main(bot.id)).id,
      '[izin:SandboxNetworkAccess {"host":"localhost"}] [izin:SandboxNetworkAccess {"host":"192.168.1.1"}]',
    );
    expect(text).toContain('localhost bu bilgisayarda ya da yerel ağda');
    expect(text).toContain('192.168.1.1 bu bilgisayarda ya da yerel ağda');
  });

  it('kapalıyken komutların çıkışını her izin kipinde reddeder', async () => {
    const bot = await t.bot({ internet: false, permissionMode: 'auto' });
    const text = await reply((await main(bot.id)).id, '[izin:SandboxNetworkAccess {"host":"93.184.215.14"}]');
    expect(text).toContain('SandboxNetworkAccess: reddedildi (Bu botun internet erişimi kapalı');
    expect(await pending()).toHaveLength(0);
    expect(t.engine.requests.at(-1)!.sandbox.internet).toBe(false);
  });
});
