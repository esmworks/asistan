import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Bot, Memory } from '@yumakbot/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '../src/db';
import { BACKUP_MAGIC, tablesInOrder } from '../src/services/backup';
import { newId } from '../src/util';
import { AUTH, testServer, type TestServer } from './helpers';

const PASSWORD = 'yedek-şifresi-2026';

describe('yedek', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const download = async (password: string) => {
    const made = await t.api<{ id: string; size: number }>('POST', '/api/backup', { password });
    if (made.status !== 200) return { status: made.status, file: null };
    const res = await t.app.inject({ method: 'GET', url: `/api/backup/${made.body.id}`, headers: AUTH });
    expect(res.headers['content-disposition']).toMatch(/yumakbot-backup-.*\.ybk/);
    expect(res.rawPayload.length).toBe(made.body.size);
    // One download: the file does not wait on the server once fetched.
    await new Promise((r) => setTimeout(r, 50));
    expect(
      (await t.app.inject({ method: 'GET', url: `/api/backup/${made.body.id}`, headers: AUTH })).statusCode,
    ).toBe(404);
    return { status: 200, file: res.rawPayload };
  };
  const restore = (file: Buffer, password: string) =>
    t.app.inject({
      method: 'POST',
      url: '/api/backup/restore',
      headers: {
        ...AUTH,
        'content-type': 'application/octet-stream',
        'x-backup-password': encodeURIComponent(password),
      },
      payload: file,
    });
  const botNames = async () => (await t.api<Bot[]>('GET', '/api/bots')).body.map((b) => b.name).sort();

  it('tabloları üst tablolar önce gelecek biçimde sıralar', () => {
    const order = tablesInOrder();
    expect(order.indexOf(schema.bots)).toBeLessThan(order.indexOf(schema.threads));
    expect(order.indexOf(schema.threads)).toBeLessThan(order.indexOf(schema.messages));
    expect(order.indexOf(schema.routines)).toBeLessThan(order.indexOf(schema.routineRuns));
  });

  it('her şeyi şifreli tek dosyaya yazar ve geri yükler; yanlış şifre ya da bozuk dosya hiçbir şeyi değiştirmez', async () => {
    const ali = await t.bot({ name: 'Ali' });
    await t.api('POST', '/api/memory', { scope: 'bot', botId: ali.id, content: 'Raporlar cuma' });
    const files = join(t.dataDir, 'workspaces', 'bots', ali.id, 'files');
    mkdirSync(files, { recursive: true });
    writeFileSync(join(files, 'not.txt'), 'ilk hali');

    expect((await download('kısa')).status).toBe(400);
    const { file } = await download(PASSWORD);
    expect(file!.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)).toBe(true);
    // Sealed: neither the note nor the file's text can be read in it.
    expect(file!.includes(Buffer.from('Raporlar cuma'))).toBe(false);

    // Things change after the backup.
    await t.api('PATCH', `/api/bots/${ali.id}`, { name: 'Ali Yeni' });
    await t.bot({ name: 'Veli' });
    writeFileSync(join(files, 'not.txt'), 'sonraki hali');

    const wrong = await restore(file!, 'yanlış-şifre-12345');
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toContain('Şifre yanlış');
    const damaged = Buffer.from(file!);
    damaged[damaged.length - 40]! ^= 0xff;
    expect((await restore(damaged, PASSWORD)).statusCode).toBe(400);
    expect((await restore(Buffer.from('başka bir dosya'), PASSWORD)).statusCode).toBe(400);
    expect(await botNames()).toEqual(['Ali Yeni', 'Veli']);
    expect(readFileSync(join(files, 'not.txt'), 'utf8')).toBe('sonraki hali');

    const restarted = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ok = await restore(file!, PASSWORD);
    expect(ok.statusCode).toBe(200);
    expect(await botNames()).toEqual(['Ali']);
    expect((await t.api<Memory[]>('GET', '/api/memory')).body.map((m) => m.content)).toEqual([
      'Raporlar cuma',
    ]);
    expect(readFileSync(join(files, 'not.txt'), 'utf8')).toBe('ilk hali');
    // What it replaced is kept beside it, to undo by hand.
    expect(existsSync(join(t.dataDir, 'workspaces.before-restore'))).toBe(true);
    // The server is asked to start again: what it holds in memory belongs to the old data.
    await vi.waitFor(() => expect(restarted).toHaveBeenCalled());
    restarted.mockRestore();
    // This sign-in still works: sign-ins to this server are not part of a backup.
    expect((await t.api('GET', '/api/bots')).status).toBe(200);
  });

  it('bir bot çalışırken geri yüklemez', async () => {
    const { file } = await download(PASSWORD);
    const bot = await t.bot();
    const thread = (await t.api<{ id: string }>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await t.services.ctx.db.insert(schema.turns).values({
      id: newId(),
      threadId: thread.id,
      botId: bot.id,
      status: 'running',
      prompt: 'x',
      source: 'user',
    });
    const busy = await restore(file!, PASSWORD);
    expect(busy.statusCode).toBe(409);
  });
});
