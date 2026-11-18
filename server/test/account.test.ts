import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addressGroup,
  FAILURE_WINDOW_MS,
  GLOBAL_FREE_FAILURES,
  GLOBAL_MAX_PAUSE_MS,
  GLOBAL_PAUSE_MS,
  GLOBAL_WINDOW_MS,
  LoginThrottle,
  MAX_FAILURES,
} from '../src/account';
import { OWNER_ID } from '../src/users';
import { KEY, testServer, type TestServer } from './helpers';

describe('kullanıcı adı ve şifreyle giriş', () => {
  let t: TestServer;
  beforeAll(async () => {
    t = await testServer();
  });
  afterAll(() => t.dispose());

  const send = (method: string, url: string, payload?: object, headers: Record<string, string> = {}) =>
    t.app.inject({
      method: method as 'POST',
      url,
      headers: { host: 'localhost', ...headers },
      ...(payload ? { payload } : {}),
    });
  const auth = { authorization: `Bearer ${KEY}` };
  const cookieOf = (r: { headers: Record<string, unknown> }) =>
    String(r.headers['set-cookie']).split(';')[0]!;

  it('hesap yokken giriş sayfası anahtar ister, şifreyle giriş olmaz', async () => {
    expect((await send('GET', '/api/session')).json()).toEqual({ authenticated: false, account: false });
    expect((await send('POST', '/api/login', { username: 'erhan', password: 'herhangi1' })).statusCode).toBe(
      401,
    );
  });

  it('hesap oturumla kurulur; kısa şifre reddedilir', async () => {
    expect(
      (await send('PUT', '/api/account', { username: 'erhan', password: 'gizli-sifre' })).statusCode,
    ).toBe(401);
    expect(
      (await send('PUT', '/api/account', { username: 'erhan', password: 'kisa' }, auth)).statusCode,
    ).toBe(400);
    const made = await send('PUT', '/api/account', { username: 'Erhan', password: 'gizli-sifre' }, auth);
    expect(made.json()).toEqual({ username: 'Erhan' });
    expect((await send('GET', '/api/account', undefined, auth)).json()).toEqual({ username: 'Erhan' });
    expect((await send('GET', '/api/session')).json()).toEqual({ authenticated: false, account: true });
  });

  it('doğru kullanıcı adı ve şifre oturum açar; yanlışları açmaz', async () => {
    expect(
      (await send('POST', '/api/login', { username: 'erhan', password: 'yanlis-sifre' })).statusCode,
    ).toBe(401);
    expect(
      (await send('POST', '/api/login', { username: 'baska', password: 'gizli-sifre' })).statusCode,
    ).toBe(401);
    // The username is matched without regard to case or surrounding spaces.
    const ok = await send('POST', '/api/login', { username: ' erhan ', password: 'gizli-sifre' });
    expect(ok.statusCode).toBe(200);
    const cookie = cookieOf(ok);
    expect((await send('GET', '/api/bots', undefined, { cookie })).statusCode).toBe(200);
  });

  it('şifre değişikliği mevcut şifreyi ya da erişim anahtarını ister', async () => {
    const change = (current?: string) =>
      send('PUT', '/api/account', { username: 'erhan', password: 'yeni-sifre-1', current }, auth);
    expect((await change()).statusCode).toBe(403);
    expect((await change('yanlis')).statusCode).toBe(403);
    expect((await change('gizli-sifre')).statusCode).toBe(200);
    // A forgotten password is replaced with the access key.
    const viaKey = await send(
      'PUT',
      '/api/account',
      { username: 'erhan', password: 'yeni-sifre-2', current: KEY },
      auth,
    );
    expect(viaKey.statusCode).toBe(200);
    expect(
      (await send('POST', '/api/login', { username: 'erhan', password: 'yeni-sifre-1' })).statusCode,
    ).toBe(401);
    expect(
      (await send('POST', '/api/login', { username: 'erhan', password: 'yeni-sifre-2' })).statusCode,
    ).toBe(200);
  });

  it('veritabanında şifrenin kendisi değil yalnızca özeti durur', async () => {
    const rows = await t.db.db.query.users.findMany();
    const stored = JSON.stringify(rows.find((r) => r.id === OWNER_ID)?.password);
    expect(stored).toContain('"hash"');
    expect(stored).not.toContain('yeni-sifre-2');
  });
});

describe('LoginThrottle', () => {
  it('çok sayıda yanlış denemeden sonra pencere geçene kadar bekletir', () => {
    const c = { at: 0 };
    const throttle = new LoginThrottle(() => c.at);
    for (let i = 0; i < MAX_FAILURES; i++) expect(throttle.attempt('1.2.3.4')).not.toBeNull();
    expect(throttle.attempt('1.2.3.4')).toBeNull();
    expect(throttle.attempt('5.6.7.8')).not.toBeNull();
    c.at += FAILURE_WINDOW_MS + 1;
    // A right try hands its count back, and the address starts over.
    throttle.attempt('1.2.3.4')!.succeeded();
    for (let i = 0; i < MAX_FAILURES; i++) expect(throttle.attempt('1.2.3.4')).not.toBeNull();
    expect(throttle.attempt('1.2.3.4')).toBeNull();
  });

  it('bir IPv6 /64 ağındaki adresler tek adres sayılır', () => {
    expect(addressGroup('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(addressGroup('2001:0db8:0001:0002:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64');
    expect(addressGroup('2001:db8::5')).toBe('2001:db8:0:0::/64');
    expect(addressGroup('::1')).toBe('0:0:0:0::/64');
    expect(addressGroup('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(addressGroup('203.0.113.9')).toBe('203.0.113.9');
    const throttle = new LoginThrottle(() => 0);
    for (let i = 0; i < MAX_FAILURES; i++) expect(throttle.attempt(`2001:db8:1:2::${i + 1}`)).not.toBeNull();
    expect(throttle.attempt('2001:db8:1:2:dead:beef:0:1')).toBeNull();
    expect(throttle.attempt('2001:db8:1:3::1')).not.toBeNull();
  });

  // Each new address gets MAX_FAILURES tries of its own; without a ceiling across all of them, a
  // guesser with many addresses would get unlimited tries.
  it('adres değiştirmek sınırsız deneme kazandırmaz; tavan yalnızca yavaşlatır', () => {
    const c = { at: 0 };
    const throttle = new LoginThrottle(() => c.at);
    let n = 0;
    const fresh = () => `198.51.${Math.floor(n / 250)}.${(n++ % 250) + 1}`;
    for (let i = 0; i < GLOBAL_FREE_FAILURES; i++) expect(throttle.attempt(fresh())).not.toBeNull();
    // Past the ceiling the next try waits for the pause, and one goes through after it.
    expect(throttle.attempt(fresh())).toBeNull();
    c.at += GLOBAL_PAUSE_MS - 1;
    expect(throttle.attempt(fresh())).toBeNull();
    c.at += 1;
    expect(throttle.attempt(fresh())).not.toBeNull();
    expect(throttle.attempt(fresh())).toBeNull();
    // The pause grows as failures go on, up to its longest.
    for (let i = 0; i < 100; i++) {
      c.at += GLOBAL_MAX_PAUSE_MS;
      expect(throttle.attempt(fresh())).not.toBeNull();
    }
    const last = c.at;
    c.at += GLOBAL_MAX_PAUSE_MS - 1;
    expect(throttle.attempt(fresh())).toBeNull();
    // A check that is not counted across addresses (the access key) is not slowed by it.
    expect(throttle.attempt(fresh(), { shared: false })).not.toBeNull();
    // Once the failures leave the window, tries are free again.
    c.at = last + GLOBAL_WINDOW_MS + GLOBAL_MAX_PAUSE_MS * 3;
    expect(throttle.attempt(fresh())).not.toBeNull();
    expect(throttle.attempt(fresh())).not.toBeNull();
  });
});

describe('giriş sınırı ve şifre değişikliği', () => {
  let t: TestServer;
  beforeAll(async () => {
    t = await testServer();
    const made = await t.app.inject({
      method: 'PUT',
      url: '/api/account',
      headers: { host: 'localhost', authorization: `Bearer ${KEY}` },
      payload: { username: 'erhan', password: 'gizli-sifre' },
    });
    expect(made.statusCode).toBe(200);
  });
  afterAll(() => t.dispose());

  const login = (password: string, from = '127.0.0.1') =>
    t.app.inject({
      method: 'POST',
      url: '/api/login',
      remoteAddress: from,
      headers: { host: 'localhost' },
      payload: { username: 'erhan', password },
    });

  // The password check is slow on purpose; tries sent all at once were all let through before
  // any of them was counted.
  it('aynı anda gönderilen yanlış şifreler sınırı aşamaz', async () => {
    const replies = await Promise.all(
      Array.from({ length: MAX_FAILURES * 3 }, () => login('yanlis-sifre', '192.0.2.10')),
    );
    const codes = replies.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 401)).toHaveLength(MAX_FAILURES);
    expect(codes.filter((c) => c === 429)).toHaveLength(MAX_FAILURES * 2);
    expect((await login('gizli-sifre', '192.0.2.10')).statusCode).toBe(429);
    expect((await login('gizli-sifre', '192.0.2.11')).statusCode).toBe(200);
  });

  it('şifre değişince diğer cihazların oturumları kapanır, değiştiren cihazınki açık kalır', async () => {
    const cookieOf = (r: { headers: Record<string, unknown> }) =>
      String(r.headers['set-cookie']).split(';')[0]!;
    const phone = cookieOf(await login('gizli-sifre'));
    const laptop = cookieOf(await login('gizli-sifre'));
    const bots = (cookie: string) =>
      t.app.inject({ method: 'GET', url: '/api/bots', headers: { host: 'localhost', cookie } });
    expect((await bots(phone)).statusCode).toBe(200);
    const change = await t.app.inject({
      method: 'PUT',
      url: '/api/account',
      headers: { host: 'localhost', origin: 'http://localhost', cookie: laptop },
      payload: { username: 'erhan', password: 'yeni-sifre-1', current: 'gizli-sifre' },
    });
    expect(change.statusCode).toBe(200);
    expect((await bots(phone)).statusCode).toBe(401);
    expect((await bots(laptop)).statusCode).toBe(200);
  });

  it('erişim anahtarı ve Bearer denemeleri adres başına sınırlanır', async () => {
    const access = (key: string, from: string) =>
      t.app.inject({
        method: 'POST',
        url: '/api/access',
        remoteAddress: from,
        headers: { host: 'localhost' },
        payload: { key },
      });
    for (let i = 0; i < MAX_FAILURES; i++)
      expect((await access('yanlis', '192.0.2.20')).statusCode).toBe(401);
    expect((await access(KEY, '192.0.2.20')).statusCode).toBe(429);
    expect((await access(KEY, '192.0.2.21')).statusCode).toBe(200);
    const bearer = (key: string, from: string) =>
      t.app.inject({
        method: 'GET',
        url: '/api/bots',
        remoteAddress: from,
        headers: { host: 'localhost', authorization: `Bearer ${key}` },
      });
    for (let i = 0; i < MAX_FAILURES; i++)
      expect((await bearer('yanlis', '192.0.2.30')).statusCode).toBe(401);
    expect((await bearer(KEY, '192.0.2.30')).statusCode).toBe(429);
    // A right key does not use up an address's tries.
    for (let i = 0; i < MAX_FAILURES * 2; i++) expect((await bearer(KEY, '192.0.2.31')).statusCode).toBe(200);
  });
});
