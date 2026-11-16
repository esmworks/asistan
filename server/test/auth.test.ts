import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkHostOrigin, clientAddress, SESSION_IDLE_MS } from '../src/auth';
import { loadConfig, publicUrl } from '../src/config';
import { KEY, testServer, type TestServer } from './helpers';

describe('erişim', () => {
  let t: TestServer;
  beforeAll(async () => {
    t = await testServer();
  });
  afterAll(() => t.dispose());

  const req = (opts: { url?: string; method?: string; headers?: Record<string, string>; payload?: object }) =>
    t.app.inject({
      method: (opts.method ?? 'GET') as 'GET',
      url: opts.url ?? '/api/bots',
      headers: { host: 'localhost', ...opts.headers },
      ...(opts.payload ? { payload: opts.payload } : {}),
    });

  it('anahtarsız /api isteğini reddeder', async () => {
    expect((await req({})).statusCode).toBe(401);
    expect((await req({ headers: { authorization: 'Bearer yanlis' } })).statusCode).toBe(401);
  });

  it('bearer anahtarı kabul eder, sağlık uç noktası açıktır', async () => {
    expect((await req({ headers: { authorization: `Bearer ${KEY}` } })).statusCode).toBe(200);
    expect((await req({ url: '/api/health' })).statusCode).toBe(200);
  });

  it('anahtarı sorgu dizesinde kabul etmez', async () => {
    expect((await req({ url: `/api/bots?token=${KEY}` })).statusCode).toBe(401);
  });

  it('doğru anahtarla HttpOnly SameSite=Strict cookie verir', async () => {
    expect((await req({ method: 'POST', url: '/api/access', payload: { key: 'yanlis' } })).statusCode).toBe(
      401,
    );
    const ok = await req({ method: 'POST', url: '/api/access', payload: { key: KEY } });
    expect(ok.statusCode).toBe(200);
    const setCookie = String(ok.headers['set-cookie']);
    expect(setCookie).toMatch(/yumakbot_session=/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    const cookie = setCookie.split(';')[0]!;
    expect((await req({ headers: { cookie } })).statusCode).toBe(200);
    // Cookie writes need an Origin from our own host.
    const noOrigin = await req({
      method: 'POST',
      url: '/api/groups',
      headers: { cookie },
      payload: { name: 'x' },
    });
    expect(noOrigin.statusCode).toBe(403);
    const sameOrigin = await req({
      method: 'POST',
      url: '/api/groups',
      headers: { cookie, origin: 'http://localhost' },
      payload: { name: 'x' },
    });
    expect(sameOrigin.statusCode).toBe(200);
    // Logout ends the session.
    await req({ method: 'POST', url: '/api/logout', headers: { cookie, origin: 'http://localhost' } });
    expect((await req({ headers: { cookie } })).statusCode).toBe(401);
  });

  it('oturum açık cihazları listeler; birini ya da diğerlerinin hepsini kapatır', async () => {
    const signIn = async (ua: string) => {
      const r = await req({
        method: 'POST',
        url: '/api/access',
        payload: { key: KEY },
        headers: { 'user-agent': ua },
      });
      return String(r.headers['set-cookie']).split(';')[0]!;
    };
    const mac = await signIn('Mac Chrome');
    const phone = await signIn('iPhone Safari');
    const tablet = await signIn('iPad Safari');
    const list = async (cookie: string) =>
      (await req({ url: '/api/sessions', headers: { cookie } })).json() as {
        id: string;
        userAgent: string;
        current: boolean;
      }[];
    const seen = await list(mac);
    expect(seen.find((x) => x.current)?.userAgent).toBe('Mac Chrome');
    const phoneId = seen.find((x) => x.userAgent === 'iPhone Safari')!.id;
    const del = (cookie: string, id: string) =>
      req({ method: 'DELETE', url: `/api/sessions/${id}`, headers: { cookie, origin: 'http://localhost' } });
    expect((await del(mac, phoneId)).json()).toEqual({ ended: 1 });
    expect((await req({ headers: { cookie: phone } })).statusCode).toBe(401);
    expect((await del(mac, 'others')).json()).toMatchObject({ ended: expect.any(Number) });
    expect((await req({ headers: { cookie: tablet } })).statusCode).toBe(401);
    expect((await req({ headers: { cookie: mac } })).statusCode).toBe(200);
  });

  it('uzun süre kullanılmayan oturum kapanır, kullanılan oturum uzar', async () => {
    const token = await t.auth.createSession('test');
    const later = new Date(Date.now() + SESSION_IDLE_MS - 60_000);
    expect(await t.auth.validSession(token, later)).toBe(true);
    const muchLater = new Date(later.getTime() + SESSION_IDLE_MS - 120_000);
    expect(await t.auth.validSession(token, muchLater)).toBe(true);
    const tooLate = new Date(muchLater.getTime() + SESSION_IDLE_MS + 120_000);
    expect(await t.auth.validSession(token, tooLate)).toBe(false);
    expect(await t.auth.validSession(token, tooLate)).toBe(false);
  });

  it('yabancı Host, yabancı Origin ve Origin: null reddedilir', async () => {
    const auth = { authorization: `Bearer ${KEY}` };
    expect((await req({ headers: { ...auth, host: 'evil.example' } })).statusCode).toBe(403);
    expect((await req({ headers: { ...auth, origin: 'https://evil.example' } })).statusCode).toBe(403);
    expect((await req({ headers: { ...auth, origin: 'null' } })).statusCode).toBe(403);
  });
});

describe('checkHostOrigin', () => {
  const config = loadConfig(
    {},
    { allowedHosts: ['yumakbot.example.com'], allowedOrigins: ['https://app.example.com'] },
  );
  const check = (host: string | undefined, origin?: string) =>
    checkHostOrigin({ host, origin, method: 'GET' }, config);
  it('loopback ve izinli adlar', () => {
    expect(check('localhost:4319')).toBeNull();
    expect(check('127.0.0.1:4319')).toBeNull();
    expect(check('[::1]:4319')).toBeNull();
    expect(check('yumakbot.example.com')).toBeNull();
    expect(check('yumakbot.example.com', 'https://yumakbot.example.com')).toBeNull();
    expect(check('yumakbot.example.com', 'https://app.example.com')).toBeNull();
  });
  it('rebinding ve yabancı kaynaklar', () => {
    expect(check(undefined)).not.toBeNull();
    expect(check('attacker.com')).not.toBeNull();
    expect(check('localhost', 'https://attacker.com')).not.toBeNull();
    expect(check('localhost', 'null')).not.toBeNull();
  });
});

describe('genel adres', () => {
  it('YUMAKBOT_PUBLIC_URL köke indirgenir, geçersizi yok sayılır', () => {
    expect(publicUrl('https://yumakbot.example.com/')).toBe('https://yumakbot.example.com');
    expect(publicUrl(' https://ornek.com:8443/yumakbot/ ')).toBe('https://ornek.com:8443/yumakbot');
    expect(publicUrl('')).toBeNull();
    expect(publicUrl('ftp://ornek.com')).toBeNull();
    expect(publicUrl('ornek.com')).toBeNull();
  });
  it('genel adresin ana bilgisayar adı izinli sayılır', () => {
    const config = loadConfig({ YUMAKBOT_PUBLIC_URL: 'https://yumakbot.example.com' });
    expect(
      checkHostOrigin({ host: 'yumakbot.example.com', origin: undefined, method: 'GET' }, config),
    ).toBeNull();
    expect(
      checkHostOrigin({ host: 'baska.example.com', origin: undefined, method: 'GET' }, config),
    ).not.toBeNull();
  });
});

describe('ters vekil arkasında', () => {
  const config = { proxySecret: 'vekil-sirri-0123456789' };
  it('X-Forwarded-For yalnızca vekilin sırrıyla gelen istekte okunur', () => {
    const forwarded = { 'x-forwarded-for': '198.51.100.7, 203.0.113.1' };
    expect(
      clientAddress({ ...forwarded, 'x-yumakbot-proxy': config.proxySecret }, '172.18.0.1', config),
    ).toBe('203.0.113.1');
    expect(clientAddress(forwarded, '172.18.0.1', config)).toBe('172.18.0.1');
    expect(clientAddress({ ...forwarded, 'x-yumakbot-proxy': 'yanlis' }, '172.18.0.1', config)).toBe(
      '172.18.0.1',
    );
    expect(
      clientAddress({ ...forwarded, 'x-yumakbot-proxy': config.proxySecret }, '172.18.0.1', {
        proxySecret: null,
      }),
    ).toBe('172.18.0.1');
    expect(clientAddress({ 'x-yumakbot-proxy': config.proxySecret }, '172.18.0.1', config)).toBe(
      '172.18.0.1',
    );
  });

  // Behind Caddy every request arrives from the same address; without the proxy's word, ten wrong
  // passwords from one person would lock everyone out.
  it('giriş sınırı vekilin bildirdiği adrese göre sayılır', async () => {
    const t = await testServer(config);
    try {
      const account = await t.app.inject({
        method: 'PUT',
        url: '/api/account',
        headers: { host: 'localhost', authorization: `Bearer ${KEY}` },
        payload: { username: 'erhan', password: 'gizli-sifre' },
      });
      expect(account.statusCode).toBe(200);
      const login = (from: string) =>
        t.app.inject({
          method: 'POST',
          url: '/api/login',
          headers: { host: 'localhost', 'x-forwarded-for': from, 'x-yumakbot-proxy': config.proxySecret },
          payload: { username: 'erhan', password: 'yanlis-sifre' },
        });
      for (let i = 0; i < 10; i++) expect((await login('203.0.113.1')).statusCode).toBe(401);
      expect((await login('203.0.113.1')).statusCode).toBe(429);
      expect((await login('203.0.113.2')).statusCode).toBe(401);
    } finally {
      await t.dispose();
    }
  });
});
