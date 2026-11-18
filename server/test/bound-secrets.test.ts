import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EmailSettings } from '@yumakbot/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openWith, sealWith } from '../src/crypto';
import { schema } from '../src/db';
import { ApiCredentialService } from '../src/services/api-credentials';
import { BOUND_FILE } from '../src/services/vault';
import { newId } from '../src/util';
import { testServer, type TestServer } from './helpers';
import { OWNER_ID } from '../src/users';

describe('AES-GCM ile mühürleme', () => {
  const key = randomBytes(32);

  it('ek veriye bağlı mühür yalnızca aynı ek veriyle açılır', () => {
    const aad = Buffer.from('satır-1|site.example');
    const sealed = sealWith(key, 'parola', aad);
    expect(openWith(key, sealed, aad)).toBe('parola');
    expect(() => openWith(key, sealed, Buffer.from('satır-1|kotu.example'))).toThrow();
    expect(() => openWith(key, sealed)).toThrow();
  });

  it('16 bayttan kısa etiketi kabul etmez', () => {
    const [iv, tag, data] = sealWith(key, 'parola').split(':') as [string, string, string];
    const short = Buffer.from(tag, 'base64').subarray(0, 4).toString('base64');
    expect(() => openWith(key, `${iv}:${short}:${data}`)).toThrow('Unknown sealed format');
    expect(openWith(key, `${iv}:${tag}:${data}`)).toBe('parola');
  });
});

describe('satırına ve adresine bağlı sırlar', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const db = () => t.services.ctx.db;
  const login = async (site: string) => {
    const r = await t.api<{ id: string }>('POST', '/api/vault', {
      site,
      username: 'erhan',
      password: `parola-${site}`,
    });
    expect(r.status).toBe(200);
    return r.body.id;
  };

  it('veritabanında sitesi değiştirilen ya da başka satıra taşınan parola doldurulmaz', async () => {
    const bank = await login('banka.example');
    const forum = await login('forum.example');
    expect(
      (await t.services.vault.forHost('banka.example', undefined, OWNER_ID)).map((c) => c.password),
    ).toEqual(['parola-banka.example']);

    // Someone who can only write to the database points the bank's password at their own site.
    await db()
      .update(schema.vaultLogins)
      .set({ site: 'kotu.example' })
      .where(eq(schema.vaultLogins.id, bank));
    expect(await t.services.vault.forHost('kotu.example', undefined, OWNER_ID)).toEqual([]);

    // Or moves it into another row.
    const [b] = await db().select().from(schema.vaultLogins).where(eq(schema.vaultLogins.id, bank));
    await db().update(schema.vaultLogins).set({ secret: b!.secret }).where(eq(schema.vaultLogins.id, forum));
    expect(await t.services.vault.forHost('forum.example', undefined, OWNER_ID)).toEqual([]);
  });

  it('site uygulamadan değişince parola ve doğrulama sırrı yeni siteye bağlanır', async () => {
    const id = await login('eski.example');
    const totp = 'JBSWY3DPEHPK3PXP';
    expect((await t.api('PATCH', `/api/vault/${id}`, { totp })).status).toBe(200);
    expect((await t.api('PATCH', `/api/vault/${id}`, { site: 'yeni.example' })).status).toBe(200);
    const [c] = await t.services.vault.forHost('yeni.example', undefined, OWNER_ID);
    expect(c).toMatchObject({ password: 'parola-eski.example', totp });
  });

  it('bağlanmadan önce kaydedilmiş parolalar ilk kullanımda bağlanır, sonra bağsız değer açılmaz', async () => {
    const vault = t.services.vault;
    expect(existsSync(join(t.dataDir, BOUND_FILE))).toBe(false);
    const old = newId();
    const legacy = vault.seal('eski-parola');
    expect(legacy.startsWith('v1:')).toBe(true);
    await db()
      .insert(schema.vaultLogins)
      .values({
        id: old,
        site: 'eski.example',
        username: 'erhan',
        secret: legacy,
        totp: vault.seal('JBSWY3DPEHPK3PXP'),
      });

    expect(await vault.forHost('eski.example', undefined, OWNER_ID)).toMatchObject([
      { password: 'eski-parola', totp: 'JBSWY3DPEHPK3PXP' },
    ]);
    const [row] = await db().select().from(schema.vaultLogins).where(eq(schema.vaultLogins.id, old));
    expect(row!.secret.startsWith('v2:')).toBe(true);
    expect(row!.totp!.startsWith('v2:')).toBe(true);
    expect(JSON.parse(readFileSync(join(t.dataDir, BOUND_FILE), 'utf8'))).toContain('vault_logins');

    // An unbound secret from elsewhere (the Claude token, a bot's token) put in a row afterwards is
    // not opened, so it cannot be typed into the site the row names.
    await db()
      .insert(schema.vaultLogins)
      .values({ id: newId(), site: 'kotu.example', username: 'x', secret: vault.seal('telegram-jetonu') });
    expect(await vault.forHost('kotu.example', undefined, OWNER_ID)).toEqual([]);
  });

  it('API anahtarı yalnızca kaydedildiği adrese gider; eski anahtarlar bağlanır', async () => {
    const sent: { url: string; auth: string | null }[] = [];
    const fetcher = (async (url: URL, init: RequestInit) => {
      sent.push({ url: String(url), auth: new Headers(init.headers).get('authorization') });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const keys = new ApiCredentialService(t.services.ctx, t.services.vault, fetcher);
    const bot = await t.bot();
    const made = await keys.create({
      name: 'hava',
      origin: 'https://api.hava.example',
      auth: { type: 'bearer' },
      value: 'anahtar-123456',
    });
    await keys.call(bot.id, 'hava', { method: 'GET', url: '/bugun' });
    expect(sent.at(-1)).toEqual({ url: 'https://api.hava.example/bugun', auth: 'Bearer anahtar-123456' });

    // The origin changed in the database: the key no longer opens, and nothing is sent.
    await db()
      .update(schema.apiCredentials)
      .set({ origin: 'https://kotu.example' })
      .where(eq(schema.apiCredentials.id, made.id));
    await expect(keys.call(bot.id, 'hava', { method: 'GET', url: '/topla' })).rejects.toThrow();
    expect(sent).toHaveLength(1);

    // Changed through the app, the key is sealed again for the new origin.
    await db()
      .update(schema.apiCredentials)
      .set({ origin: 'https://api.hava.example' })
      .where(eq(schema.apiCredentials.id, made.id));
    await keys.update(made.id, { origin: 'https://yeni.hava.example' });
    await keys.call(bot.id, 'hava', { method: 'GET', url: '/bugun' });
    expect(sent.at(-1)).toEqual({ url: 'https://yeni.hava.example/bugun', auth: 'Bearer anahtar-123456' });

    // Once the table is bound, an unbound key put in afterwards (copied from another secret) is
    // not opened, so it is not sent to the origin its row names.
    expect(JSON.parse(readFileSync(join(t.dataDir, BOUND_FILE), 'utf8'))).toContain('api_credentials');
    await db()
      .insert(schema.apiCredentials)
      .values({
        id: newId(),
        name: 'kopya',
        origin: 'https://kotu.example',
        auth: { type: 'bearer' },
        secret: t.services.vault.seal('claude-jetonu-99'),
      });
    await expect(keys.call(bot.id, 'kopya', { method: 'GET', url: '/' })).rejects.toThrow();
    expect(sent).toHaveLength(2);
  });

  it('bağlanmadan önce kaydedilmiş API anahtarı ilk kullanımda çalışır ve bağlanır', async () => {
    const sent: string[] = [];
    const fetcher = (async (_url: URL, init: RequestInit) => {
      sent.push(new Headers(init.headers).get('authorization') ?? '');
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const old = newId();
    await db()
      .insert(schema.apiCredentials)
      .values({
        id: old,
        name: 'eski',
        origin: 'https://eski.example',
        auth: { type: 'bearer' },
        secret: t.services.vault.seal('eski-anahtar-99'),
      });
    const keys = new ApiCredentialService(t.services.ctx, t.services.vault, fetcher);
    const bot = await t.bot();
    await keys.call(bot.id, 'eski', { method: 'GET', url: '/' });
    expect(sent).toEqual(['Bearer eski-anahtar-99']);
    const [row] = await db().select().from(schema.apiCredentials).where(eq(schema.apiCredentials.id, old));
    expect(row!.secret.startsWith('v2:')).toBe(true);
  });

  it('e-posta aktarıcısının sırrı mühürlü saklanır; düz saklanmış eskisi çalışmaya devam eder', async () => {
    await db().insert(schema.kv).values({ key: 'email.inboundSecret', value: 'eski-duz-sir' });
    expect((await t.api<EmailSettings>('GET', '/api/email')).body.secret).toBe('eski-duz-sir');
    const stored = async () =>
      (await db().select().from(schema.kv).where(eq(schema.kv.key, 'email.inboundSecret')))[0]!
        .value as string;
    expect(await stored()).toMatch(/^v2:/);
    expect((await t.api<EmailSettings>('GET', '/api/email')).body.secret).toBe('eski-duz-sir');

    const renewed = (await t.api<EmailSettings>('POST', '/api/email/secret')).body.secret!;
    expect(renewed).not.toBe('eski-duz-sir');
    expect(await stored()).toMatch(/^v2:/);
    expect(await stored()).not.toContain(renewed);
  });
});
