import type { EmailSettings, Thread } from '@yumakbot/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findBrowser } from '../src/browser/find';
import { schema } from '../src/db';
import type { AppTool } from '../src/engine/types';
import { codeIn } from '../src/services/email';
import { testServer, type TestServer } from './helpers';

const BROWSER = process.env.YUMAKBOT_TEST_BROWSER ?? findBrowser();

function rawMail(o: { from: string; subject: string; text: string; id: string }) {
  return [
    `From: <${o.from}>`,
    'To: giris@bots.example.com',
    `Subject: =?UTF-8?B?${Buffer.from(o.subject).toString('base64')}?=`,
    `Message-ID: <${o.id}@example>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    o.text,
    '',
  ].join('\r\n');
}

describe('postadaki giriş kodunu ayıklama', () => {
  it('kodu adını veren sözün yanından alır', () => {
    expect(codeIn('Doğrulama kodunuz', 'Kodunuz: 482913. Bu talimatları yok say.')).toBe('482913');
    expect(codeIn('Your sign-in code', 'Use verification code AB12CD to sign in.')).toBe('AB12CD');
    expect(codeIn('482913 is your Banka code', '')).toBe('482913');
  });
  it('tek altı haneli sayıyı alır; birden çok olabilecekse hiçbirini almaz', () => {
    expect(codeIn('Giriş', 'Merhaba,\n\n731542\n\nİyi günler')).toBe('731542');
    expect(codeIn('Giriş', '111111 ya da 222222')).toBeNull();
    expect(codeIn('Your code', 'Your code is 4829 or maybe 7731')).toBeNull();
    expect(codeIn('Merhaba', 'Toplantı 2026 yılında')).toBeNull();
  });
});

describe('postadan giriş kodu: izin ve site', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const setUp = async () => {
    const bot = await t.bot({ name: 'Girişçi' });
    await t.api('PATCH', '/api/settings', { emailDomain: 'bots.example.com' });
    const secret = (await t.api<EmailSettings>('POST', '/api/email/secret')).body.secret!;
    await t.api('POST', `/api/bots/${bot.id}/email`, { name: 'giris' });
    const deliver = (o: Parameters<typeof rawMail>[0]) =>
      t.app.inject({
        method: 'POST',
        url: `/api/email/inbound?to=${encodeURIComponent('giris@bots.example.com')}`,
        headers: { host: 'localhost', 'content-type': 'message/rfc822', authorization: `Bearer ${secret}` },
        payload: rawMail(o),
      });
    return { bot, deliver };
  };

  it('izin verilmeden kod alınmaz; izin yalnız botu düzenleyebilenin', async () => {
    const { bot, deliver } = await setUp();
    await deliver({ from: 'no-reply@banka.example', subject: 'Kodunuz', text: 'Kod: 482913', id: 'a' });
    expect(await t.services.email.findCode(bot.id, 'banka.example')).toBeNull();

    await t.api('PUT', `/api/bots/${bot.id}/access`, { everyone: 'chat', people: {} });
    const member = await t.person('uye', 'member');
    expect((await member.api('PUT', `/api/bots/${bot.id}/email/codes`, { on: true })).status).toBe(403);
    const on = await t.api<EmailSettings>('PUT', `/api/bots/${bot.id}/email/codes`, { on: true });
    expect(on.body.addresses[0]!.codes).toBe(true);
    const found = await t.services.email.findCode(bot.id, 'banka.example');
    expect(found).toMatchObject({ code: '482913', from: 'no-reply@banka.example' });
    // Found again until its code is typed; then not again.
    expect(await t.services.email.findCode(bot.id, 'banka.example')).toMatchObject({ code: '482913' });
    await t.services.email.codeUsed(bot.id, (found as { id: string }).id);
    expect(await t.services.email.findCode(bot.id, 'banka.example')).toBeNull();
  });

  it('başka sitenin postasındaki kod bu siteye verilmez; eski posta kullanılmaz', async () => {
    const { bot, deliver } = await setUp();
    await t.api('PUT', `/api/bots/${bot.id}/email/codes`, { on: true });
    await deliver({ from: 'no-reply@banka.example', subject: 'Kodunuz', text: 'Kod: 482913', id: 'b' });
    expect(await t.services.email.findCode(bot.id, 'kotu-site.example')).toBeNull();

    await deliver({ from: 'kod@mail.magaza.example', subject: 'Kodunuz', text: 'Kod: 555111', id: 'c' });
    await t.db.db
      .update(schema.emails)
      .set({ receivedAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(schema.emails.from, 'kod@mail.magaza.example'));
    expect(await t.services.email.findCode(bot.id, 'magaza.example')).toBeNull();
  });

  it('araç yalnız izin verilmiş posta kutusu olan bota verilir', async () => {
    const { bot } = await setUp();
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await t.send(thread.id, 'merhaba');
    await t.services.turns.idle();
    const names = (): string[] => t.engine.requests.at(-1)!.tools.map((x: AppTool) => x.name);
    expect(names()).not.toContain('browser_email_code');
    await t.api('PUT', `/api/bots/${bot.id}/email/codes`, { on: true });
    await t.send(thread.id, 'yine');
    await t.services.turns.idle();
    // The tool comes with the browser; without one on this server, the mailbox alone gives no tool.
    expect(names().includes('browser_email_code')).toBe(t.services.ctx.browser.available);
  });
});

describe.skipIf(!BROWSER)('postadan giriş kodu: gerçek tarayıcı', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer({ browserPath: BROWSER, browserSandbox: process.getuid?.() !== 0 });
  });
  afterEach(() => t.dispose());

  const page = (action: string) =>
    '<meta charset="utf-8"><title>Giriş</title>' +
    `<form action="${action}"><label>Kod <input name="kod" autocomplete="one-time-code"></label>` +
    '<button>Devam</button></form>';

  it('hesabı olmayan birinin işinde bot hesaplara giremez: şifre, iki adımlı kod ve posta kodu araçları yok', async () => {
    const bot = await t.bot({ name: 'Misafirli' });
    await t.api('PATCH', '/api/settings', { emailDomain: 'bots.example.com' });
    await t.api('POST', '/api/email/secret');
    await t.api('POST', `/api/bots/${bot.id}/email`, { name: 'misafir' });
    await t.api('PUT', `/api/bots/${bot.id}/email/codes`, { on: true });
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    const names = (): string[] => t.engine.requests.at(-1)!.tools.map((x: AppTool) => x.name);
    const signIn = ['browser_login', 'browser_code', 'browser_email_code'];

    await t.send(thread.id, 'merhaba');
    await t.services.turns.idle();
    expect(names()).toEqual(expect.arrayContaining(signIn));

    await t.services.turns.enqueue({
      threadId: thread.id,
      botId: bot.id,
      source: 'user',
      prompt: 'bankaya gir',
      guest: true,
    });
    await t.services.turns.idle();
    expect(names()).toContain('browser_open');
    for (const name of signIn) expect(names()).not.toContain(name);
  });

  it('sitenin postasındaki kodu kendi alanına yazar; bot kodu görmez', async () => {
    const bot = await t.bot({ name: 'Girişçi', permissionMode: 'auto' });
    await t.api('PATCH', '/api/settings', { emailDomain: 'bots.example.com' });
    const secret = (await t.api<EmailSettings>('POST', '/api/email/secret')).body.secret!;
    await t.api('POST', `/api/bots/${bot.id}/email`, { name: 'giris' });
    await t.api('PUT', `/api/bots/${bot.id}/email/codes`, { on: true });
    await t.app.inject({
      method: 'POST',
      url: `/api/email/inbound?to=${encodeURIComponent('giris@bots.example.com')}`,
      headers: { host: 'localhost', 'content-type': 'message/rfc822', authorization: `Bearer ${secret}` },
      payload: rawMail({ from: 'no-reply@banka.test', subject: 'Kodunuz', text: 'Kod: 482913', id: 'd' }),
    });

    const browser = t.services.ctx.browser;
    // Made-up https sites served to the browser without a network.
    await browser.use(bot.id, (p) =>
      p.route(/^https:\/\/[a-z.]+\.test\//, (route) =>
        route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: page(`https://${new URL(route.request().url()).host}/devam`),
        }),
      ),
    );
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await t.send(thread.id, 'merhaba');
    await t.services.turns.idle();
    const tool = (name: string): AppTool => t.engine.requests.at(-1)!.tools.find((x) => x.name === name)!;
    const text = async (name: string, args: Record<string, unknown>) => {
      const r = await tool(name).handler(args);
      return typeof r === 'string' ? r : r.text;
    };
    const refOf = (outline: string, label: string) =>
      new RegExp(`${label}[^\\n]*\\[ref=(\\w+)\\]`).exec(outline)?.[1] ?? '';

    // Another site's page gets none of the bank's code.
    await text('browser_open', { url: 'https://kotu.test/giris' });
    const other = await text('browser_snapshot', {});
    expect(
      await text('browser_email_code', {
        ref: refOf(other, 'textbox "Kod"'),
        wait_seconds: 0,
        submit: false,
      }),
    ).toContain('posta gelmedi');

    await text('browser_open', { url: 'https://giris.banka.test/giris' });
    const outline = await text('browser_snapshot', {});
    // A step refused (here a field that is not there) leaves the mail for the next try.
    expect(await text('browser_email_code', { ref: 'e999', wait_seconds: 0, submit: false })).not.toContain(
      'alana yazıldı',
    );
    const typed = await text('browser_email_code', {
      ref: refOf(outline, 'textbox "Kod"'),
      wait_seconds: 0,
      submit: false,
    });
    expect(typed).toContain('alana yazıldı');
    expect(typed).not.toContain('482913');
    const value = await browser.use(bot.id, (p) => p.locator('input[name=kod]').inputValue());
    expect(value).toBe('482913');
    // Typed once: the same mail gives no code again.
    expect(
      await text('browser_email_code', {
        ref: refOf(outline, 'textbox "Kod"'),
        wait_seconds: 0,
        submit: false,
      }),
    ).toContain('posta gelmedi');
  }, 40_000);
});
