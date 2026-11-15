import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Thread } from '@yumakbot/shared';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KEY, testServer, type TestServer } from './helpers';

describe('Socket.IO', () => {
  let t: TestServer;
  let url: string;
  const sockets: Socket[] = [];
  beforeAll(async () => {
    t = await testServer();
    url = await t.listen();
  });
  afterAll(async () => {
    for (const s of sockets) s.close();
    await t.dispose();
  });

  const open = (opts: Parameters<typeof connect>[1] = {}) => {
    const s = connect(url, { transports: ['websocket'], reconnection: false, ...opts });
    sockets.push(s);
    return s;
  };

  it('anahtarla bağlanır, hello alır; akış ve tur olaylarını taşır', async () => {
    const s = open({ extraHeaders: { authorization: `Bearer ${KEY}` } });
    const hello = await new Promise<{ bootId: string }>((resolve, reject) => {
      s.on('hello', resolve);
      s.on('connect_error', reject);
    });
    expect(hello.bootId).toBe(t.bootId);

    const deltas: string[] = [];
    const states: string[] = [];
    s.on('delta', (e: { text: string }) => deltas.push(e.text));
    s.on('turn', (e: { state: string }) => states.push(e.state));
    const bot = await t.bot();
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await t.send(thread.id, 'akış denemesi');
    await t.services.turns.idle();
    await new Promise((r) => setTimeout(r, 50));
    expect(deltas.join('')).toContain('Yankı: akış denemesi');
    expect(states).toContain('running');
    expect(states.at(-1)).toBe('idle');
  });

  it('çalışan turun o an kullandığı aracı yalnızca değişince bildirir', async () => {
    const s = open({ extraHeaders: { authorization: `Bearer ${KEY}` } });
    await new Promise((resolve) => s.on('hello', resolve));
    const tools: (string | null)[] = [];
    s.on('tool', (e: { tool: string | null }) => tools.push(e.tool));
    const bot = await t.bot();
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await t.send(thread.id, '[uzun-araç:200] [uzun-araç:200]');
    await t.services.turns.idle();
    await new Promise((r) => setTimeout(r, 50));
    expect(tools).toEqual(['Bash', null, 'Bash', null]);
  });

  it('botun tarayıcısını izleyene canlı kareler gider; izlemeyi bırakana gitmez', async () => {
    const s = open({ extraHeaders: { authorization: `Bearer ${KEY}` } });
    await new Promise((resolve) => s.on('hello', resolve));
    const bot = await t.bot();
    await new Promise((resolve) => s.emit('browser:watch', bot.id, resolve));
    const frames: string[] = [];
    s.on('browser:frame', (f: { botId: string; data: string }) => frames.push(`${f.botId}:${f.data}`));
    // The manager hands a frame to every listener; the server sends it to the bot's watchers.
    const emit = (data: string) =>
      (
        t.services.ctx.browser as unknown as { listeners: Set<{ frame(id: string, f: object): void }> }
      ).listeners.forEach((l) => l.frame(bot.id, { data, width: 10, height: 10 }));
    emit('kare1');
    await new Promise((r) => setTimeout(r, 100));
    expect(frames).toEqual([`${bot.id}:kare1`]);
    s.emit('browser:unwatch', bot.id);
    await new Promise((r) => setTimeout(r, 50));
    emit('kare2');
    await new Promise((r) => setTimeout(r, 100));
    expect(frames).toHaveLength(1);
  });

  it('tarayıcı yolu: oturum cookie ile bağlanır, yabancı Origin reddedilir', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/access',
      headers: { host: 'localhost' },
      payload: { key: KEY },
    });
    const cookie = String(res.headers['set-cookie']).split(';')[0]!;
    const port = new URL(url).port;
    const good = open({ extraHeaders: { cookie, origin: `http://127.0.0.1:${port}` } });
    await new Promise((resolve, reject) => {
      good.on('hello', resolve);
      good.on('connect_error', reject);
    });
    const bad = open({ extraHeaders: { cookie, origin: 'https://evil.example' } });
    await new Promise((resolve) => bad.on('connect_error', resolve));
    expect(bad.connected).toBe(false);
  });

  it('anahtarsız ya da sorgu dizesindeki anahtarla bağlanamaz', async () => {
    for (const s of [open(), open({ query: { token: KEY } })]) {
      const err = await new Promise<Error>((resolve) => s.on('connect_error', resolve));
      expect(err).toBeInstanceOf(Error);
      expect(s.connected).toBe(false);
    }
  });
});

describe('kütüphane', () => {
  let t: TestServer;
  beforeAll(async () => {
    t = await testServer();
  });
  afterAll(() => t.dispose());

  it('bot klasöründeki dosyaları listeler ve indirir; dışarı çıkan yolları ve bağlantıları reddeder', async () => {
    const bot = await t.bot();
    const files = join(t.dataDir, 'workspaces', 'bots', bot.id, 'files');
    mkdirSync(files, { recursive: true });
    writeFileSync(join(files, 'rapor.txt'), 'merhaba');
    symlinkSync(join(homedir(), '.ssh'), join(files, 'kacak'));
    symlinkSync('/etc/hosts', join(files, 'hosts'));

    const list = (await t.api<{ path: string }[]>('GET', `/api/bots/${bot.id}/library`)).body;
    expect(list.map((f) => f.path)).toEqual([`bots/${bot.id}/files/rapor.txt`]);

    const ok = await t.app.inject({
      url: `/api/bots/${bot.id}/library/file?path=${encodeURIComponent(`bots/${bot.id}/files/rapor.txt`)}`,
      headers: { authorization: `Bearer ${KEY}`, host: 'localhost' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('merhaba');

    for (const p of [`bots/${bot.id}/files/hosts`, `bots/${bot.id}/../../../../etc/hosts`, '/etc/hosts']) {
      const r = await t.app.inject({
        url: `/api/bots/${bot.id}/library/file?path=${encodeURIComponent(p)}`,
        headers: { authorization: `Bearer ${KEY}`, host: 'localhost' },
      });
      expect([403, 404]).toContain(r.statusCode);
    }
  });
});

describe('Socket.IO yeniden başlatma', () => {
  it('kapanan sunucu bağlantıyı kendisi keser; connect() yeniden açılan sunucuya bağlanır', async () => {
    const first = await testServer();
    const url = await first.listen();
    const port = Number(new URL(url).port);
    const s = connect(url, {
      transports: ['websocket'],
      extraHeaders: { authorization: `Bearer ${KEY}` },
      reconnectionDelay: 50,
      reconnectionDelayMax: 100,
    });
    let second: TestServer | null = null;
    try {
      await new Promise((resolve, reject) => {
        s.once('hello', resolve);
        s.once('connect_error', reject);
      });
      const gone = new Promise<string>((resolve) => s.once('disconnect', resolve));
      await first.dispose();
      // The client does not retry this reason on its own; the app calls connect() for it.
      expect(await gone).toBe('io server disconnect');
      expect(s.active).toBe(false);

      s.connect();
      second = await testServer({ port });
      await second.listen();
      const hello = await new Promise<{ bootId: string }>((resolve) => s.once('hello', resolve));
      expect(hello.bootId).toBe(second.bootId);
    } finally {
      s.close();
      await second?.dispose();
    }
  });
});
