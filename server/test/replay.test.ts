import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ReplayResult, Skill, TaughtStep, Thread } from '@yumakbot/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findBrowser } from '../src/browser/find';
import { replayHandOver } from '../src/browser/replay';
import { translator } from '../src/i18n';
import { testServer, type TestServer } from './helpers';

const BROWSER = process.env.YUMAKBOT_TEST_BROWSER ?? findBrowser();
const t = translator('tr') as unknown as (key: string, params?: Record<string, string | number>) => string;

const steps = (base: string): TaughtStep[] => [
  { kind: 'open', url: base },
  {
    kind: 'type',
    target: { what: 'field', label: 'Arama', secret: false },
    text: 'haftalık',
    secret: false,
    url: base,
  },
  { kind: 'click', target: { what: 'button', label: 'Ara', secret: false }, url: base },
];

describe('öğretilen görevi yeniden oynatma: tarayıcısız', () => {
  let s: TestServer;
  beforeEach(async () => {
    s = await testServer();
  });
  afterEach(() => s.dispose());

  it('gösterilen adımlar beceriyle saklanır ve geri okunur', async () => {
    const bot = await s.bot();
    const created = await s.api<Skill>('POST', '/api/skills', {
      name: 'rapor-ara',
      description: 'Raporu ara',
      body: '1. Ara.',
      steps: steps('https://crm.example/'),
      botIds: [bot.id],
    });
    expect(created.status).toBe(200);
    expect(created.body.steps).toHaveLength(3);
    const listed = (await s.api<Skill[]>('GET', '/api/skills')).body.find((k) => k.name === 'rapor-ara')!;
    expect(listed.steps![1]).toMatchObject({ kind: 'type', text: 'haftalık' });
  });

  it('adımı olmayan beceri yeniden oynatılamaz; botta olmayan beceri bulunmaz', async () => {
    const bot = await s.bot();
    const other = await s.bot({ name: 'Ayşe' });
    const plain = (
      await s.api<Skill>('POST', '/api/skills', { name: 'yazili', description: 'x', botIds: [bot.id] })
    ).body;
    const r = await s.api('POST', `/api/bots/${bot.id}/skills/${plain.id}/replay`);
    expect(r.status).toBe(409);
    const elsewhere = await s.api('POST', `/api/bots/${other.id}/skills/${plain.id}/replay`);
    expect(elsewhere.status).toBe(404);
  });

  it('yalnız botu düzenleyebilen yeniden oynatabilir', async () => {
    const bot = await s.bot();
    const skill = (
      await s.api<Skill>('POST', '/api/skills', {
        name: 'rapor-ara',
        description: 'Raporu ara',
        steps: steps('https://crm.example/'),
        botIds: [bot.id],
      })
    ).body;
    // The member may talk to the bot but not change it.
    await s.api('PUT', `/api/bots/${bot.id}/access`, { everyone: 'chat', people: {} });
    const member = await s.person('uye', 'member');
    const r = await member.api('POST', `/api/bots/${bot.id}/skills/${skill.id}/replay`);
    expect(r.status).toBe(403);
  });

  it('duran oynatma botuna nerede ve neden durduğunu, kalan adımlarla söyler', () => {
    const all = steps('https://crm.example/');
    const text = replayHandOver(
      { ok: false, done: 2, total: 3, failedAt: { step: 3, reason: 'Sayfada “Ara” düğme bulunamadı.' } },
      all,
      t,
    );
    expect(text).toContain('3 adımın 3. adımında durdu');
    expect(text).toContain('Tıkla: “Ara” düğme.');
    expect(text).not.toContain('haftalık');
  });
});

describe.skipIf(!BROWSER)('öğretilen görevi yeniden oynatma: gerçek tarayıcı', () => {
  let site: Server;
  let base: string;
  let s: TestServer;

  beforeAll(async () => {
    site = httpServer((req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      if (req.url?.startsWith('/sonuc')) {
        res.end(
          `<meta charset="utf-8"><h1>Sonuç: ${new URL(req.url, 'http://x').searchParams.get('q')}</h1>`,
        );
        return;
      }
      res.end(
        '<meta charset="utf-8"><form action="/sonuc"><label for="q">Arama</label>' +
          '<input id="q" name="q"><button>Ara</button></form>',
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

  const save = async (botId: string, taught: TaughtStep[]) =>
    (
      await s.api<Skill>('POST', '/api/skills', {
        name: 'rapor-ara',
        description: 'Raporu ara',
        steps: taught,
        botIds: [botId],
      })
    ).body;

  it('gösterilen adımları model olmadan yapar', async () => {
    const bot = await s.bot();
    const skill = await save(bot.id, steps(base));
    const r = await s.api<ReplayResult>('POST', `/api/bots/${bot.id}/skills/${skill.id}/replay`);
    expect(r.body).toEqual({ ok: true, done: 3, total: 3 });
    const heading = await s.services.ctx.browser.use(bot.id, (page) => page.locator('h1').innerText());
    expect(heading).toBe('Sonuç: haftalık');
    expect(s.engine.requests).toHaveLength(0);
  });

  it('sayfaya uymayan adımda durur ve hangisi olduğunu söyler', async () => {
    const bot = await s.bot();
    const taught = steps(base);
    taught[2] = { kind: 'click', target: { what: 'button', label: 'Dışa aktar', secret: false }, url: base };
    const skill = await save(bot.id, taught);
    const r = await s.api<ReplayResult>('POST', `/api/bots/${bot.id}/skills/${skill.id}/replay`);
    expect(r.body.ok).toBe(false);
    expect(r.body.done).toBe(2);
    expect(r.body.failedAt!.step).toBe(3);
    expect(r.body.failedAt!.reason).toContain('Dışa aktar');
  }, 30_000);

  it('şifre adımında durur; şifreyi bot ya da kişi girer', async () => {
    const bot = await s.bot();
    const taught: TaughtStep[] = [
      { kind: 'open', url: base },
      {
        kind: 'type',
        target: { what: 'field', label: 'Arama', secret: true },
        text: '',
        secret: true,
        url: base,
      },
    ];
    const skill = await save(bot.id, taught);
    const r = await s.api<ReplayResult>('POST', `/api/bots/${bot.id}/skills/${skill.id}/replay`);
    expect(r.body).toMatchObject({ ok: false, done: 1, failedAt: { step: 2 } });
  });

  it('bot aracıyla yeniden oynatır; durursa kalan adımları okur', async () => {
    const bot = await s.bot({ permissionMode: 'auto' });
    const taught = steps(base);
    taught[2] = { kind: 'click', target: { what: 'button', label: 'Dışa aktar', secret: false }, url: base };
    await save(bot.id, taught);
    const thread = (await s.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await s.send(thread.id, '[araç:skill_replay {"name":"rapor-ara"}]');
    await s.services.turns.idle(30_000);
    const tools = s.engine.requests[0]!.tools.map((x) => x.name);
    expect(tools).toContain('skill_replay');
    const said = (await s.messages(thread.id)).map((m) => m.text).join('\n');
    expect(said).toContain('3. adımında durdu');
  }, 40_000);
});
