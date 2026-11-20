import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import type { ApnsRequest, ApnsResponse } from '../src/services/apns';
import { KEY, testServer, type TestServer } from './helpers';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const P8 = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const APNS = { teamId: 'TEAM123456', keyId: 'KEY1234567', bundleId: 'com.leafbot.app', key: P8 };
const TOKEN = 'ab'.repeat(32);

describe('telefon bildirimleri', () => {
  let t: TestServer;
  let sent: ApnsRequest[];
  let answer: (req: ApnsRequest) => ApnsResponse;
  beforeEach(async () => {
    t = await testServer();
    sent = [];
    answer = () => ({ status: 200 });
    t.services.push.transport = async (req) => {
      sent.push(req);
      return answer(req);
    };
  });
  afterEach(() => t.dispose());

  const device = (body: Partial<Record<string, unknown>> = {}) =>
    t.api('PUT', '/api/push/device', { token: TOKEN, platform: 'ios', locale: 'tr', level: 'all', ...body });
  const notice = async (kind: 'reply' | 'needsYou' | 'error', botId: string, text = 'Bitti') => {
    await t.services.push.notice({ kind, botId, threadId: 'th1', text });
  };

  it('Apple anahtarını şifreli saklar, yalnızca kimlikleri gösterir', async () => {
    expect((await t.api('GET', '/api/push/apns')).body).toMatchObject({ configured: false });
    expect((await t.api('PUT', '/api/push/apns', { ...APNS, key: `${'x'.repeat(120)}` })).status).toBe(400);
    const r = await t.api('PUT', '/api/push/apns', APNS);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      configured: true,
      teamId: APNS.teamId,
      keyId: APNS.keyId,
      bundleId: APNS.bundleId,
    });
    const rows = await t.db.db.select().from(schema.kv);
    const secret = P8.split('\n')[2]!;
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(JSON.stringify((await t.api('GET', '/api/push/apns')).body)).not.toContain(secret);
    expect((await t.api('DELETE', '/api/push/apns')).body).toMatchObject({ configured: false });
  });

  it('bot yanıtını imzalı bir istekle kayıtlı iPhone’a gönderir', async () => {
    await t.api('PUT', '/api/push/apns', APNS);
    const bot = await t.bot({ name: 'Yazıcı' });
    expect((await device()).status).toBe(200);
    await notice('reply', bot.id, 'Rapor hazır');
    expect(sent).toHaveLength(1);
    const req = sent[0]!;
    expect(req.token).toBe(TOKEN);
    expect(req.sandbox).toBe(false);
    expect(req.headers).toMatchObject({
      'apns-topic': 'com.leafbot.app',
      'apns-push-type': 'alert',
      'apns-collapse-id': 'reply:th1',
    });
    expect(JSON.parse(req.body)).toEqual({
      aps: { alert: { title: 'Yazıcı', body: 'Rapor hazır' }, sound: 'default', 'thread-id': 'th1' },
      kind: 'reply',
      botId: bot.id,
      threadId: 'th1',
    });
    // The token Apple checks: ES256 over header and claims, signed with the saved key.
    const [h, c, s] = req.headers.authorization!.replace('bearer ', '').split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ alg: 'ES256', kid: APNS.keyId });
    expect(JSON.parse(Buffer.from(c!, 'base64url').toString())).toMatchObject({ iss: APNS.teamId });
    const ok = verify(
      'sha256',
      Buffer.from(`${h}.${c}`),
      { key: createPublicKey(privateKey), dsaEncoding: 'ieee-p1363' },
      Buffer.from(s!, 'base64url'),
    );
    expect(ok).toBe(true);
  });

  it('telefonun seçimlerine uyar: yalnızca istekler, susturulan botlar, dil', async () => {
    await t.api('PUT', '/api/push/apns', APNS);
    const a = await t.bot({ name: 'A' });
    const b = await t.bot({ name: 'B' });
    await device({ level: 'needsYou', locale: 'en', mutes: { [b.id]: null } });
    await notice('reply', a.id);
    await notice('needsYou', b.id);
    expect(sent).toHaveLength(0);
    await notice('needsYou', a.id);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!.body).aps.alert.title).toBe('A needs you');
    await device({ level: 'off' });
    await notice('needsYou', a.id);
    expect(sent).toHaveLength(1);
  });

  it('Xcode’dan kurulan uygulamanın test servisini kullandığını öğrenir', async () => {
    await t.api('PUT', '/api/push/apns', APNS);
    const bot = await t.bot();
    await device();
    answer = (req) => (req.sandbox ? { status: 200 } : { status: 400, reason: 'BadDeviceToken' });
    await notice('reply', bot.id);
    expect(sent.map((r) => r.sandbox)).toEqual([false, true]);
    await notice('reply', bot.id);
    expect(sent.map((r) => r.sandbox)).toEqual([false, true, true]);
  });

  it('uygulaması silinen telefonu bırakır', async () => {
    await t.api('PUT', '/api/push/apns', APNS);
    const bot = await t.bot();
    await device();
    answer = () => ({ status: 410, reason: 'Unregistered' });
    await notice('reply', bot.id);
    expect(await t.db.db.select().from(schema.pushDevices)).toHaveLength(0);
  });

  it('oturumu kapanan telefona bir şey göndermez', async () => {
    await t.api('PUT', '/api/push/apns', APNS);
    const bot = await t.bot();
    const inject = (opts: { method: string; url: string; cookie?: string; payload?: object }) =>
      t.app.inject({
        method: opts.method as 'POST',
        url: opts.url,
        headers: {
          host: 'localhost',
          origin: 'http://localhost',
          ...(opts.cookie && { cookie: opts.cookie }),
        },
        ...(opts.payload && { payload: opts.payload }),
      });
    const signIn = await inject({ method: 'POST', url: '/api/access', payload: { key: KEY } });
    const cookie = String(signIn.headers['set-cookie']).split(';')[0]!;
    const put = await inject({
      method: 'PUT',
      url: '/api/push/device',
      cookie,
      payload: { token: TOKEN, platform: 'ios', locale: 'tr', level: 'all' },
    });
    expect(put.statusCode).toBe(200);
    await notice('reply', bot.id);
    expect(sent).toHaveLength(1);
    await inject({ method: 'POST', url: '/api/logout', cookie });
    await notice('reply', bot.id);
    expect(sent).toHaveLength(1);
    expect(await t.db.db.select().from(schema.pushDevices)).toHaveLength(0);
  });

  it('deneme bildirimi anahtar yoksa bunu söyler', async () => {
    await device();
    expect((await t.api('POST', '/api/push/test', { token: TOKEN })).status).toBe(409);
    await t.api('PUT', '/api/push/apns', APNS);
    expect((await t.api('POST', '/api/push/test', { token: TOKEN })).status).toBe(200);
    expect(JSON.parse(sent[0]!.body).aps.alert.body).toBe('Bildirimler bu telefonda çalışıyor.');
    expect((await t.api('POST', '/api/push/test', { token: 'cd'.repeat(32) })).status).toBe(404);
  });
});
