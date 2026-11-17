import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findBrowser } from '../src/browser/find';
import { VIEWPORT } from '../src/browser/manager';
import { addTyping, stepsText, type TeachStep } from '../src/browser/teach';
import { translator } from '../src/i18n';
import { testServer, type TestServer } from './helpers';

const BROWSER = process.env.YUMAKBOT_TEST_BROWSER ?? findBrowser();
const t = translator('tr') as unknown as (key: string, params?: Record<string, string | number>) => string;

describe('gösterek öğretme: adımların yazılışı', () => {
  it('aynı alana yazılanları birleştirir; şifreyi hiç tutmaz', () => {
    const steps: TeachStep[] = [{ kind: 'open', url: 'https://crm.example/raporlar' }];
    const field = { what: 'field', label: 'Arama', secret: false };
    addTyping(steps, field, 'haf', 'https://crm.example/raporlar');
    addTyping(steps, field, 'talık', 'https://crm.example/raporlar');
    addTyping(
      steps,
      { what: 'field', label: 'Şifre', secret: true },
      'gizli',
      'https://crm.example/raporlar',
    );
    steps.push({
      kind: 'click',
      target: { what: 'button', label: 'Dışa aktar', secret: false },
      url: 'https://crm.example/raporlar',
    });
    steps.push({ kind: 'key', key: 'Enter', url: 'https://crm.example/indir' });
    const text = stepsText(steps, t);
    expect(text).toBe(
      [
        '1. https://crm.example/raporlar adresini aç.',
        '2. “haftalık” yaz: “Arama” alan.',
        '3. Şifreyi gir: “Şifre” alan (browser_login kullan, şifreyi asla kendin yazma).',
        '4. Tıkla: “Dışa aktar” düğme.',
        '5. (Sayfa https://crm.example/indir adresine geçer.)',
        '6. Enter tuşuna bas.',
      ].join('\n'),
    );
    expect(text).not.toContain('gizli');
  });
});

describe.skipIf(!BROWSER)('gösterek öğretme: gerçek tarayıcı', () => {
  let site: Server;
  let base: string;
  let s: TestServer;

  beforeAll(async () => {
    site = httpServer((_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(
        '<meta charset="utf-8"><body style="margin:0">' +
          '<label for="q">Arama</label><input id="q" style="display:block;width:300px;height:40px">' +
          '<input type="password" aria-label="Şifre" style="display:block;width:300px;height:40px">' +
          '<button style="display:block;width:200px;height:40px">Raporu indir</button></body>',
      );
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
  });
  afterAll(() => new Promise<void>((r) => site.close(() => r())));
  beforeEach(async () => {
    s = await testServer({
      browserPath: BROWSER,
      browserSandbox: process.getuid?.() !== 0,
      browserLocalHosts: ['127.0.0.1'],
    });
  });
  afterEach(() => s.dispose());

  it('kontrol kişideyken yapılanları kaydeder ve beceri taslağı verir', async () => {
    const bot = await s.bot();
    const browser = s.services.ctx.browser;
    await browser.use(bot.id, (page) => page.goto(base, { waitUntil: 'load' }));
    const box = (sel: string) =>
      browser.use(bot.id, async (page) => (await page.locator(sel).boundingBox())!);
    const field = await box('#q');
    const password = await box('input[type=password]');
    const button = await box('button');
    const click = async (b: { x: number; y: number; width: number; height: number }) => {
      const x = (b.x + b.width / 2) / VIEWPORT.width;
      const y = (b.y + b.height / 2) / VIEWPORT.height;
      await browser.input(bot.id, { type: 'mouse', action: 'down', x, y });
      await browser.input(bot.id, { type: 'mouse', action: 'up', x, y });
    };

    expect((await s.api('POST', `/api/bots/${bot.id}/teach`)).status).toBe(200);
    await click(field);
    await browser.input(bot.id, { type: 'text', text: 'kasım' });
    await click(password);
    await browser.input(bot.id, { type: 'text', text: 'cok-gizli-sifre' });
    await click(button);
    expect((await s.api<{ steps: number }>('GET', `/api/bots/${bot.id}/teach`)).body.steps).toBe(6);

    const draft = await s.api<{ name: string; description: string; body: string }>(
      'POST',
      `/api/bots/${bot.id}/teach/stop`,
      { goal: 'Aylık raporu indir' },
    );
    expect(draft.status).toBe(200);
    expect(draft.body.name).toBe('aylik-raporu-indir');
    expect(draft.body.body).toContain(`${base} adresini aç.`);
    expect(draft.body.body).toContain('“kasım” yaz: “Arama” alan.');
    expect(draft.body.body).toContain('Şifreyi gir: “Şifre” alan');
    expect(draft.body.body).toContain('Tıkla: “Raporu indir” düğme.');
    expect(draft.body.body).not.toContain('cok-gizli-sifre');
    // Stopped: nothing more is recorded, and stopping again has nothing to give.
    expect((await s.api<{ steps: number | null }>('GET', `/api/bots/${bot.id}/teach`)).body.steps).toBeNull();
    expect((await s.api('POST', `/api/bots/${bot.id}/teach/stop`, {})).status).toBe(409);
  });
});
