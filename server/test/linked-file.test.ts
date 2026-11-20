import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Thread } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTH, testServer, type TestServer } from './helpers';

// The app reads a file name a bot writes in a message from the conversation's folder; a bot also
// names files of its persistent and group folders that way, and those links must open too.
describe('mesajdaki dosya bağlantısı', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const put = (path: string, content: string, at?: Date) => {
    const full = join(t.dataDir, 'workspaces', path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    if (at) utimesSync(full, at, at);
  };
  /** A link as the app sends it: the name read from the conversation's folder. */
  const open = (botId: string, threadId: string, name: string) =>
    t.app.inject({
      method: 'GET',
      url: `/api/bots/${botId}/library/file?path=${encodeURIComponent(`bots/${botId}/threads/${threadId}/${name}`)}`,
      headers: { ...AUTH, host: 'localhost' },
    });

  it('kalıcı klasördeki dosyayı adıyla ya da o klasördeki yoluyla açar', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    put(`bots/${bot.id}/files/gorsel.png`, 'kalıcı');
    put(`bots/${bot.id}/files/urunler/katalog.md`, 'katalog');
    expect((await open(bot.id, thread.id, 'gorsel.png')).body).toBe('kalıcı');
    expect((await open(bot.id, thread.id, 'urunler/katalog.md')).body).toBe('katalog');
  });

  it('yalnız adı yazılan dosyayı alt klasörlerde de bulur, en yenisini açar', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    put(`bots/${bot.id}/files/eski/rapor.pdf`, 'eski', new Date('2026-01-01'));
    put(`bots/${bot.id}/files/yeni/rapor.pdf`, 'yeni', new Date('2026-06-01'));
    expect((await open(bot.id, thread.id, 'rapor.pdf')).body).toBe('yeni');
  });

  it('grup klasöründeki dosyayı da açar', async () => {
    const group = (await t.api<{ id: string }>('POST', '/api/groups', { name: 'Ekip' })).body;
    const bot = await t.bot({ groupId: group.id });
    const thread = await main(bot.id);
    put(`groups/${group.id}/files/ortak.csv`, 'grup');
    expect((await open(bot.id, thread.id, 'ortak.csv')).body).toBe('grup');
  });

  it('aynı ad konuşmanın klasöründe de varsa onu açar', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    put(`bots/${bot.id}/threads/${thread.id}/not.txt`, 'konuşma');
    put(`bots/${bot.id}/files/not.txt`, 'kalıcı');
    expect((await open(bot.id, thread.id, 'not.txt')).body).toBe('konuşma');
  });

  it('başka botun dosyasını ve klasörlerin dışını açmaz; olmayan dosya için 404 döner', async () => {
    const bot = await t.bot();
    const other = await t.bot();
    const thread = await main(bot.id);
    put(`bots/${other.id}/files/gizli.txt`, 'başkasının');
    expect((await open(bot.id, thread.id, 'gizli.txt')).statusCode).toBe(404);
    expect((await open(bot.id, thread.id, `../../../${other.id}/files/gizli.txt`)).statusCode).not.toBe(200);
    expect((await open(bot.id, thread.id, '../../../../../access-key')).statusCode).not.toBe(200);
    expect((await open(bot.id, thread.id, 'yok.md')).statusCode).toBe(404);
  });
});
