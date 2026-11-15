import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAILURE_WINDOW_MS, LoginThrottle, MAX_FAILURES } from '../src/account';
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
    const rows = await t.db.db.query.kv.findMany();
    const stored = JSON.stringify(rows.find((r) => r.key === 'account')?.value);
    expect(stored).toContain('"hash"');
    expect(stored).not.toContain('yeni-sifre-2');
  });
});

describe('LoginThrottle', () => {
  it('çok sayıda yanlış denemeden sonra pencere geçene kadar bekletir', () => {
    const c = { at: 0 };
    const throttle = new LoginThrottle(() => c.at);
    for (let i = 0; i < MAX_FAILURES - 1; i++) throttle.failed('1.2.3.4');
    expect(throttle.blocked('1.2.3.4')).toBe(false);
    throttle.failed('1.2.3.4');
    expect(throttle.blocked('1.2.3.4')).toBe(true);
    expect(throttle.blocked('5.6.7.8')).toBe(false);
    c.at += FAILURE_WINDOW_MS + 1;
    expect(throttle.blocked('1.2.3.4')).toBe(false);
    throttle.failed('1.2.3.4');
    throttle.succeeded('1.2.3.4');
    expect(throttle.blocked('1.2.3.4')).toBe(false);
  });
});
