import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PageShare, Thread } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTH, testServer, type TestServer } from './helpers';

describe('sayfayı bağlantıyla paylaşma', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(async () => {
    await t.dispose();
  });

  /** A page in the bot's main conversation folder, by its library path. */
  const page = async (html = '<h1>Rapor</h1><script>document.title = "x"</script>') => {
    const bot = await t.bot();
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    const dir = join(t.dataDir, 'workspaces', 'bots', bot.id, 'threads', thread.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'rapor.html'), html);
    writeFileSync(join(dir, 'notlar.txt'), 'düz metin');
    return { bot, dir, path: `bots/${bot.id}/threads/${thread.id}/rapor.html` };
  };
  const open = (url: string, headers: Record<string, string> = {}) =>
    t.app.inject({ method: 'GET', url, headers: { host: 'localhost', ...headers } });

  it('paylaşılan sayfa oturum açmadan, yalıtılmış olarak açılır; kapatılınca bağlantı çalışmaz', async () => {
    const { bot, dir, path } = await page();
    // Without a link, nothing opens.
    expect((await open('/p/olmayan-bir-baglanti-1234567890')).statusCode).toBe(404);

    const created = await t.api<PageShare>('POST', `/api/bots/${bot.id}/library/share`, {
      path,
      name: 'Aylık rapor',
    });
    expect(created.status).toBe(200);
    const token = created.body.token;
    expect(token.length).toBeGreaterThanOrEqual(30);
    // Sharing again gives the same link.
    const again = await t.api<PageShare>('POST', `/api/bots/${bot.id}/library/share`, { path, name: 'x' });
    expect(again.body.token).toBe(token);
    const found = await t.api<{ share: PageShare | null }>(
      'GET',
      `/api/bots/${bot.id}/library/share?path=${encodeURIComponent(path)}`,
    );
    expect(found.body.share?.token).toBe(token);

    const res = await open(`/p/${token}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<h1>Rapor</h1>');
    expect(res.body).toContain('<title>Aylık rapor</title>');
    const policy = String(res.headers['content-security-policy']);
    // An opaque origin: its scripts cannot reach this server with the visitor's sign-in.
    expect(policy).toMatch(/^sandbox allow-scripts allow-forms;/);
    expect(policy).not.toContain('allow-same-origin');
    expect(policy).toContain("connect-src 'none'");
    expect(res.headers['x-robots-tag']).toContain('noindex');

    // The link shows the page as the bot last wrote it.
    writeFileSync(join(dir, 'rapor.html'), '<h1>Güncel</h1>');
    expect((await open(`/p/${token}`)).body).toContain('<h1>Güncel</h1>');

    // Printing lets the page open the print dialog.
    const printed = await open(`/p/${token}?print=1`);
    expect(String(printed.headers['content-security-policy'])).toContain('allow-modals');
    expect(printed.body).toContain('print()');

    expect((await t.api('DELETE', `/api/page-shares/${token}`)).status).toBe(200);
    const gone = await open(`/p/${token}`, { 'accept-language': 'tr' });
    expect(gone.statusCode).toBe(404);
    expect(gone.body).toContain('artık paylaşılmıyor');
    expect(gone.body).not.toContain('Güncel');
  });

  it('silinen sayfanın bağlantısı sayfanın gittiğini söyler; HTML olmayan dosya paylaşılmaz', async () => {
    const { bot, dir, path } = await page();
    const { body } = await t.api<PageShare>('POST', `/api/bots/${bot.id}/library/share`, { path, name: 'R' });
    rmSync(join(dir, 'rapor.html'));
    const res = await open(`/p/${body.token}`);
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('text/html');

    const txt = await t.api('POST', `/api/bots/${bot.id}/library/share`, {
      path: path.replace('rapor.html', 'notlar.txt'),
      name: 'N',
    });
    expect(txt.status).toBe(400);
    // Outside the bot's folders: refused.
    const outside = await t.api('POST', `/api/bots/${bot.id}/library/share`, {
      path: '../../etc/passwd',
      name: 'E',
    });
    expect(outside.status).toBeGreaterThanOrEqual(400);
  });

  // A page's folder is the conversation's folder, which often holds other files: the link must
  // hand out the page, not everything that happens to sit beside it.
  it('paylaşılan sayfa yalnızca adını andığı veri dosyalarını taşır', async () => {
    const { bot, dir, path } = await page(
      `<h1>Satışlar</h1><script src="grafik.js"></script><script>fetch('./satis.csv')</script>`,
    );
    writeFileSync(join(dir, 'grafik.js'), `fetch('veri/bolgeler.json')`);
    writeFileSync(join(dir, 'satis.csv'), 'ay,tutar\nocak,100');
    writeFileSync(join(dir, 'eskisatis.csv'), 'ESKI-GIZLI');
    writeFileSync(join(dir, 'musteriler.json'), '{"gizli":"MUSTERI-LISTESI"}');
    mkdirSync(join(dir, 'veri'));
    writeFileSync(join(dir, 'veri', 'bolgeler.json'), '{"bolge":"EGE"}');
    writeFileSync(join(dir, 'veri', 'sifreler.txt'), 'SIFRE-DOSYASI');
    const { body } = await t.api<PageShare>('POST', `/api/bots/${bot.id}/library/share`, { path, name: 'S' });

    const shared = (await open(`/p/${body.token}`)).body;
    expect(shared).toContain('ocak,100');
    expect(shared).toContain('EGE');
    for (const secret of ['düz metin', 'ESKI-GIZLI', 'MUSTERI-LISTESI', 'SIFRE-DOSYASI']) {
      expect(shared).not.toContain(secret);
    }
    // In the app the owner's own view still carries the folder's data, for pages that build a
    // file's name as they run.
    const own = (await open(`/api/bots/${bot.id}/library/page?path=${encodeURIComponent(path)}`, AUTH)).body;
    expect(own).toContain('ocak,100');
    expect(own).toContain('MUSTERI-LISTESI');
  });

  it('paylaşım listesi ve uygulamadaki yazdırma sayfası oturum ister', async () => {
    const { bot, path } = await page();
    expect((await open('/api/page-shares')).statusCode).toBe(401);
    const printed = await open(
      `/api/bots/${bot.id}/library/page?path=${encodeURIComponent(path)}&print=1`,
      AUTH,
    );
    expect(printed.statusCode).toBe(200);
    expect(printed.body).toContain('print()');
    expect(printed.body).toContain('<title>rapor.html</title>');
  });
});
