import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StorageReport, Thread } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SizeWalk, storageReport } from '../src/storage';
import { AUTH, testServer, type TestServer } from './helpers';

describe('depolama görünümü', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const upload = (threadId: string, name: string, content: Buffer) =>
    t.app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/files?name=${encodeURIComponent(name)}`,
      headers: { ...AUTH, host: 'localhost', 'content-type': 'application/octet-stream' },
      payload: content,
    });

  it('botların klasörlerini, en büyük sohbetleri ve bekleyen ekleri adlarıyla gösterir', async () => {
    const bot = await t.bot({ name: 'Muhasebe' });
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await upload(thread.id, 'fatura.pdf', Buffer.alloc(3000, 1));
    await t.api('POST', `/api/threads/${thread.id}/messages`, {
      clientId: 'depolama-1',
      text: 'şunu oku',
      files: ['fatura.pdf'],
    });
    await t.services.turns.idle();
    // Waiting in the message box, not sent.
    await upload(thread.id, 'taslak.txt', Buffer.alloc(500, 1));
    // The bot's own folder.
    writeFileSync(join(t.dataDir, 'workspaces', 'bots', bot.id, 'files', 'notlar.md'), 'x'.repeat(200));

    const res = await t.api<StorageReport>('GET', '/api/storage');
    expect(res.status).toBe(200);
    const r = res.body;
    expect(r.capped).toBe(false);
    const b = r.bots.find((x) => x.botId === bot.id)!;
    expect(b.name).toBe('Muhasebe');
    expect(b.own).toEqual({ bytes: 200, files: 1, partial: false });
    const top = b.threads[0]!;
    expect(top.threadId).toBe(thread.id);
    expect(top.title).not.toBeNull();
    expect(top.bytes).toBeGreaterThanOrEqual(3000);
    expect(b.bytes).toBe(b.own.bytes + b.threads.reduce((n, x) => n + x.bytes, 0));
    expect(r.staged).toEqual({ bytes: 500, files: 1, partial: false });
    expect(r.total).toBe(
      r.bots.reduce((n, x) => n + x.bytes, 0) + r.groups.reduce((n, x) => n + x.bytes, 0) + 500,
    );
  });

  it('sayım sınıra takılınca kalan klasörler sıfır değil "yarım" olur', async () => {
    const a = await t.bot({ name: 'Kalabalık' });
    const b = await t.bot({ name: 'Sonraki' });
    for (const bot of [a, b]) {
      const files = join(t.dataDir, 'workspaces', 'bots', bot.id, 'files');
      mkdirSync(files, { recursive: true });
      for (let i = 0; i < 5; i++) writeFileSync(join(files, `d${i}.txt`), 'xx');
    }
    const r = await storageReport(t.services.ctx, 4);
    expect(r.capped).toBe(true);
    // Every bot is in the report, whichever was walked after the budget ran out.
    expect(r.bots.map((x) => x.botId).sort()).toEqual([a.id, b.id].sort());
    expect(r.bots.every((x) => x.partial)).toBe(true);
    expect(r.staged.partial).toBe(true);

    const full = await storageReport(t.services.ctx);
    expect(full.capped).toBe(false);
    expect(full.bots.every((x) => !x.partial)).toBe(true);
  });

  it('yalnızca yöneticiler görür', async () => {
    const member = await t.person('uye');
    expect((await member.api('GET', '/api/storage')).status).toBe(403);
    const admin = await t.person('yonetici', 'admin');
    expect((await admin.api('GET', '/api/storage')).status).toBe(200);
  });
});

describe('klasör boyutu', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'leaf-boyut-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('bağlantıları izlemez, alt klasörleri toplar', async () => {
    mkdirSync(join(dir, 'a', 'b'), { recursive: true });
    writeFileSync(join(dir, 'a', 'bir.txt'), '12345');
    writeFileSync(join(dir, 'a', 'b', 'iki.txt'), '123');
    const outside = mkdtempSync(join(tmpdir(), 'leaf-dis-'));
    writeFileSync(join(outside, 'buyuk.bin'), Buffer.alloc(10_000));
    symlinkSync(outside, join(dir, 'disari'));
    symlinkSync(join(outside, 'buyuk.bin'), join(dir, 'a', 'kisayol.bin'));
    try {
      const walk = new SizeWalk();
      expect(await walk.size(dir)).toEqual({ bytes: 8, files: 2 });
      expect(walk.capped).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('çok dosyada sınırda durur ve bunu söyler', async () => {
    for (let i = 0; i < 20; i++) writeFileSync(join(dir, `d${i}.txt`), 'x');
    const walk = new SizeWalk(10);
    const size = await walk.size(dir);
    expect(walk.capped).toBe(true);
    expect(size.files).toBeLessThanOrEqual(10);
    // The budget is shared: a second folder after the cap is not read at all.
    expect(await walk.size(dir)).toEqual({ bytes: 0, files: 0 });
  });

  it('sınırdan önce tam sayılan klasör yarım sayılmaz', async () => {
    mkdirSync(join(dir, 'kucuk'));
    mkdirSync(join(dir, 'buyuk'));
    for (let i = 0; i < 2; i++) writeFileSync(join(dir, 'kucuk', `d${i}.txt`), 'x');
    for (let i = 0; i < 20; i++) writeFileSync(join(dir, 'buyuk', `d${i}.txt`), 'x');
    const walk = new SizeWalk(5);
    expect(await walk.folder(join(dir, 'kucuk'))).toEqual({ bytes: 2, files: 2, partial: false });
    expect((await walk.folder(join(dir, 'buyuk'))).partial).toBe(true);
  });

  it('olmayan klasör boş sayılır', async () => {
    expect(await new SizeWalk().size(join(dir, 'yok'))).toEqual({ bytes: 0, files: 0 });
  });
});
