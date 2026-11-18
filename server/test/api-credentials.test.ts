import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ApiCredential, Approval, Thread } from '@yumakbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { testServer, waitFor, type Person, type TestServer } from './helpers';

const KEY_VALUE = 'sk-cok-gizli-anahtar-42';

/** A service that echoes back what it was sent, the key included, as careless services do. */
function echoService() {
  const seen: { method: string; url: string; headers: IncomingMessage['headers']; body: string }[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      if (req.url === '/redirect') {
        res.writeHead(302, { location: 'https://evil.example/collect' });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ ok: true, youSent: req.headers.authorization ?? req.headers['x-api-key'] ?? null }),
      );
    });
  });
  return {
    seen,
    async start() {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('kayıtlı API anahtarları', () => {
  let t: TestServer;
  let svc: ReturnType<typeof echoService>;
  let origin: string;
  beforeEach(async () => {
    t = await testServer();
    svc = echoService();
    origin = await svc.start();
  });
  afterEach(async () => {
    await t.dispose();
    await svc.close();
  });

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const call = async (threadId: string, tool: string, input: unknown) => {
    await t.send(threadId, `[araç:${tool} ${JSON.stringify(input)}]`);
    await t.services.turns.idle();
    return (await t.messages(threadId)).at(-1)!.text;
  };

  it('bot anahtarı korumalı kartla ister; değer hiçbir yerde görünmez ve yalnız kendi adresine gider', async () => {
    const bot = await t.bot({ name: 'Entegre' });
    const thread = await main(bot.id);
    await t.send(
      thread.id,
      `[araç:credential_request ${JSON.stringify({ key: 'Ornek', origin, label: 'Örnek servis anahtarı' })}]`,
    );
    const card = await waitFor(
      async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body[0],
    );
    // The card says where the key will go before it is typed.
    const q = (card.input.questions as { context: string; secret: boolean }[])[0]!;
    expect(q.secret).toBe(true);
    expect(q.context).toContain(origin);
    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'allow', answer: KEY_VALUE });
    await t.services.turns.idle();
    expect((await t.messages(thread.id)).at(-1)!.text).toContain('"ornek" adıyla kaydedildi');

    const keys = (await t.api<ApiCredential[]>('GET', '/api/api-keys')).body;
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ name: 'ornek', origin, botIds: [bot.id], auth: { type: 'bearer' } });

    // A read runs without a card; the service gets the key, the bot gets it taken out.
    const got = await call(thread.id, 'api_request', { key: 'ornek', url: '/v1/items?q=1' });
    expect(svc.seen.at(-1)!.headers.authorization).toBe(`Bearer ${KEY_VALUE}`);
    expect(svc.seen.at(-1)!.url).toBe('/v1/items?q=1');
    expect(got).toContain('HTTP 200');
    expect(got).toContain('Bearer [key]');
    expect(got).toContain('outside-data');

    // Never to another origin.
    const elsewhere = await call(thread.id, 'api_request', { key: 'ornek', url: 'https://evil.example/x' });
    expect(elsewhere).toContain(`yalnızca ${origin} adresine`);
    expect(svc.seen).toHaveLength(1);
    // Nor through a redirect.
    const redirected = await call(thread.id, 'api_request', { key: 'ornek', url: '/redirect' });
    expect(redirected).toContain('HTTP 302');
    expect(redirected).toContain('izlenmedi');
    // The bot cannot set the header the key goes in.
    const header = await call(thread.id, 'api_request', {
      key: 'ornek',
      url: '/x',
      headers: { Authorization: 'Bearer kendi' },
    });
    expect(header).toContain('sunucu ekler');

    // The value is nowhere a person or a bot reads: messages, cards, events, the key list.
    const everything = JSON.stringify([
      await t.messages(thread.id),
      await t.db.db.select().from(schema.approvals),
      await t.db.db.select().from(schema.apiCredentials),
      keys,
      t.engine.requests,
    ]);
    expect(everything).not.toContain(KEY_VALUE);
  });

  it('değiştiren istek onay düzeyine göre sorulur; başka bota ait anahtar kullanılamaz', async () => {
    const bot = await t.bot({ name: 'Yazar' });
    const other = await t.bot({ name: 'Diğer' });
    await t.services.apiCredentials.create(
      {
        name: 'servis',
        origin,
        auth: { type: 'header', header: 'X-API-Key' },
        value: KEY_VALUE,
        botIds: [bot.id],
      },
      null,
    );
    const thread = await main(bot.id);
    await t.send(
      thread.id,
      `[araç:api_request ${JSON.stringify({ key: 'servis', method: 'post', url: '/items', body: { a: 1 } })}]`,
    );
    const card = await waitFor(
      async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body[0],
    );
    expect(card.toolName).toContain('api_request');
    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'allow' });
    await t.services.turns.idle();
    const sent = svc.seen.at(-1)!;
    expect(sent.method).toBe('POST');
    expect(sent.headers['x-api-key']).toBe(KEY_VALUE);
    expect(JSON.parse(sent.body)).toEqual({ a: 1 });

    const otherThread = await main(other.id);
    expect(await call(otherThread.id, 'api_request', { key: 'servis', url: '/x' })).toContain(
      'izin verilmemiş',
    );
    expect(await call(otherThread.id, 'api_keys_list', {})).toContain('Kayıtlı API anahtarı yok');
    expect(await call(thread.id, 'api_keys_list', {})).toContain(`servis: ${origin} (X-API-Key başlığında)`);
  });

  it('uygulama anahtarları değerleri olmadan listeler; adres https olmalı', async () => {
    const created = await t.api<ApiCredential>('POST', '/api/api-keys', {
      name: 'hava',
      origin: 'api.weather.example/v2/forecast',
      auth: { type: 'query', param: 'appid' },
      value: KEY_VALUE,
    });
    expect(created.status).toBe(200);
    expect(created.body.origin).toBe('https://api.weather.example');
    expect(JSON.stringify(created.body)).not.toContain(KEY_VALUE);
    const plain = await t.api('POST', '/api/api-keys', {
      name: 'acik',
      origin: 'http://api.example.com',
      value: 'x',
    });
    expect(plain.status).toBe(400);
    const dup = await t.api('POST', '/api/api-keys', {
      name: 'hava',
      origin: 'https://a.example',
      value: 'y',
    });
    expect(dup.status).toBe(409);
    const updated = await t.api<ApiCredential>('PATCH', `/api/api-keys/${created.body.id}`, {
      label: 'Hava durumu',
    });
    expect(updated.body.label).toBe('Hava durumu');
    expect((await t.api('DELETE', `/api/api-keys/${created.body.id}`)).status).toBe(200);
    expect((await t.api<ApiCredential[]>('GET', '/api/api-keys')).body).toEqual([]);
  });
  describe('kime ait', () => {
    let ayse: Person;
    let mert: Person;
    beforeEach(async () => {
      ayse = await t.person('ayse');
      mert = await t.person('mert');
    });
    const shared = async (name: string) => {
      const bot = await t.bot({ name });
      await t.api('PUT', `/api/bots/${bot.id}/access`, { everyone: 'chat', people: {} });
      return bot;
    };
    const say = async (p: Person, threadId: string, text: string) => {
      const r = await p.api('POST', `/api/threads/${threadId}/messages`, {
        clientId: `c-${Math.random().toString(36).slice(2, 12)}`,
        text,
      });
      expect(r.status).toBeLessThan(300);
    };
    const mainOf = async (p: Person, botId: string) =>
      (await p.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;

    it('üyenin kartta yazdığı anahtar kendisinindir; ekibin anahtarı değişmez, başkasının işinde kullanılmaz', async () => {
      const bot = await shared('Ortak');
      // The team's key, open to every bot.
      const team = await t.api<ApiCredential>('POST', '/api/api-keys', {
        name: 'servis',
        origin,
        value: 'ekip-anahtari-123456',
      });
      expect(team.body.userId).toBeNull();

      const thread = await mainOf(ayse, bot.id);
      await say(
        ayse,
        thread.id,
        `[araç:credential_request ${JSON.stringify({ key: 'servis', origin: 'https://baska.example', label: 'Benimki' })}]`,
      );
      const card = await waitFor(
        async () => (await ayse.api<Approval[]>('GET', '/api/approvals?status=pending')).body[0],
      );
      await ayse.api('POST', `/api/approvals/${card.id}`, { decision: 'allow', answer: KEY_VALUE });
      await t.services.turns.idle();

      // The team's key is as it was; Ayşe has her own under the same name, for this bot alone.
      const all = await t.services.apiCredentials.list();
      const teams = all.filter((k) => !k.userId);
      expect(teams).toHaveLength(1);
      expect(teams[0]).toMatchObject({ id: team.body.id, origin, updatedAt: team.body.updatedAt });
      const hers = all.find((k) => k.userId === 'ayse')!;
      expect(hers).toMatchObject({ name: 'servis', origin: 'https://baska.example', botIds: [bot.id] });

      // Her list shows the team's and hers; Mert's shows only the team's.
      expect((await ayse.api<ApiCredential[]>('GET', '/api/api-keys')).body.map((k) => k.id).sort()).toEqual(
        [team.body.id, hers.id].sort(),
      );
      expect((await mert.api<ApiCredential[]>('GET', '/api/api-keys')).body.map((k) => k.id)).toEqual([
        team.body.id,
      ]);

      // Mert's turn with the same bot sends the team's key, never Ayşe's.
      const his = await mainOf(mert, bot.id);
      await say(mert, his.id, `[araç:api_request ${JSON.stringify({ key: 'servis', url: '/kim' })}]`);
      await t.services.turns.idle();
      expect(svc.seen.at(-1)!.headers.authorization).toBe('Bearer ekip-anahtari-123456');

      // A member changes neither the team's key nor another's own.
      expect((await ayse.api('PATCH', `/api/api-keys/${team.body.id}`, { value: 'x-123456' })).status).toBe(
        403,
      );
      expect((await ayse.api('DELETE', `/api/api-keys/${team.body.id}`)).status).toBe(403);
      expect((await mert.api('PATCH', `/api/api-keys/${hers.id}`, { label: 'x' })).status).toBe(404);
      expect(
        (await ayse.api('POST', '/api/api-keys', { name: 'x', origin, value: 'y', team: true })).status,
      ).toBe(403);
      // Saved by a member, a key is their own.
      const own = await mert.api<ApiCredential>('POST', '/api/api-keys', {
        name: 'kendi',
        origin,
        value: 'z',
      });
      expect(own.body.userId).toBe('mert');
    });

    it('kişinin kendi anahtarı, kendi işinde ekibin aynı adlı anahtarından önce gelir', async () => {
      const bot = await shared('Sıra');
      await t.services.apiCredentials.create({ name: 'servis', origin, value: 'ekip-anahtari-123456' }, null);
      await t.services.apiCredentials.create(
        { name: 'servis', origin, value: 'ayse-anahtari-123456' },
        'ayse',
      );
      const hers = await mainOf(ayse, bot.id);
      await say(ayse, hers.id, `[araç:api_request ${JSON.stringify({ key: 'servis', url: '/a' })}]`);
      await t.services.turns.idle();
      expect(svc.seen.at(-1)!.headers.authorization).toBe('Bearer ayse-anahtari-123456');
      const list = await t.services.apiCredentials.forBot(bot.id, 'ayse');
      expect(list.map((k) => k.userId)).toEqual(['ayse']);
      expect((await t.services.apiCredentials.forBot(bot.id, null)).map((k) => k.userId)).toEqual([null]);
    });

    it('başka bota açık kayıtlı anahtar kartta seçilip bu bota da açılabilir ya da yenisi yazılır', async () => {
      const bot = await shared('Yeni');
      const other = await shared('Eski');
      const mine = await t.services.apiCredentials.create(
        { name: 'servis', origin, value: 'ayse-anahtari-123456', botIds: [other.id] },
        'ayse',
      );
      const thread = await mainOf(ayse, bot.id);
      const ask = async () => {
        await say(
          ayse,
          thread.id,
          `[araç:credential_request ${JSON.stringify({ key: 'servis', origin, label: 'Servis' })}]`,
        );
        return waitFor(
          async () => (await ayse.api<Approval[]>('GET', '/api/approvals?status=pending')).body[0],
        );
      };
      // The card offers the saved one first; picked, it is opened to this bot as it is.
      const card = await ask();
      const q = (card.input.questions as { question: string; options: string[] }[])[0]!;
      expect(q.question).toContain(origin);
      expect(q.options).toEqual(['Kayıtlı anahtarı bu bota da aç', 'Yeni anahtar yaz']);
      await ayse.api('POST', `/api/approvals/${card.id}`, { decision: 'allow', answer: q.options[0] });
      await t.services.turns.idle();
      const said = (await ayse.api<{ text: string }[]>('GET', `/api/threads/${thread.id}/messages`)).body;
      expect(said.at(-1)!.text).toContain('anahtarını sana açtı');
      expect((await t.services.apiCredentials.get(mine.id)).botIds).toEqual([other.id, bot.id]);

      // Kept for other bots again, a new key typed on the card replaces it and this bot may use it.
      await t.services.apiCredentials.update(mine.id, { botIds: [other.id] });
      const choice = await ask();
      await ayse.api('POST', `/api/approvals/${choice.id}`, {
        decision: 'allow',
        answer: 'Yeni anahtar yaz',
      });
      const secret = await waitFor(async () => {
        const list = (await ayse.api<Approval[]>('GET', '/api/approvals?status=pending')).body;
        return list.find((a) => a.id !== choice.id);
      });
      await ayse.api('POST', `/api/approvals/${secret.id}`, {
        decision: 'allow',
        answer: 'yeni-anahtar-654321',
      });
      await t.services.turns.idle();
      expect((await t.services.apiCredentials.get(mine.id)).botIds).toEqual([other.id, bot.id]);
      await say(ayse, thread.id, `[araç:api_request ${JSON.stringify({ key: 'servis', url: '/y' })}]`);
      await t.services.turns.idle();
      expect(svc.seen.at(-1)!.headers.authorization).toBe('Bearer yeni-anahtar-654321');
    });

    it('ekip konuşmasında anahtar istenemez', async () => {
      const bot = await shared('Ekipçi');
      const made = await t.services.threads.create(bot.id, { kind: 'team', userId: null, title: 'Ekip' });
      expect(await call(made.id, 'credential_request', { key: 'k', origin, label: 'L' })).not.toContain(
        'kaydedildi',
      );
      expect((await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body).toEqual([]);
    });
  });
});
