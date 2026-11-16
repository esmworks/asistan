import { readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { Bot } from '@yumakbot/shared';
import { BrowserError } from '../browser/manager';
import type { Page } from 'playwright-core';
import { z } from 'zod';
import { VIEWPORT, webUrl, type BrowserManager } from '../browser/manager';
import { browserErrorText } from '../browser/text';
import { waitOutWall, type WallState } from '../browser/wall';
import type { AppTool, ToolResult } from '../engine/types';
import type { T } from '../i18n';
import type { LoginAnswer } from '../services/approvals';
import { registrableSite, siteMatches, siteOf, type VaultService } from '../services/vault';
import { totp } from '../totp';
import { botFile } from './files';
import type { Define } from './index';
import { workspacePaths } from '../workspace';

/** Longest page outline handed to the model; a long page is cut and the bot is told so. */
const MAX_SNAPSHOT = 40_000;

const ref = z
  .string()
  .regex(/^[\w-]{1,32}$/)
  .describe('ref from browser_snapshot, e.g. e12');
const element = z.string().max(200).describe('What the element is, in a few words');
const sends = z
  .boolean()
  .default(false)
  .describe('true if this sends, posts, buys, books, deletes or shares something');

/** Most a single upload sends to a site, all files together. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** Types sites check for most often; anything else goes as plain bytes. */
const UPLOAD_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** Shown instead of a password anywhere in what the bot reads. */
const MASK = '••••••';
/** Shorter values are not masked in free text: they would hide ordinary letters and words. */
const MIN_MASKED = 4;

/** Values of password fields on the page, in every frame. */
async function passwordValues(page: Page): Promise<string[]> {
  const perFrame = await Promise.all(
    page
      .frames()
      .map((f) =>
        f
          .$$eval('input[type=password]', (els) => els.map((e) => (e as unknown as { value: string }).value))
          .catch(() => [] as string[]),
      ),
  );
  return perFrame.flat();
}

export type AskLogin = (
  site: string,
  /** The exact host, when the person may want the login kept for it alone. */
  host?: string,
) => Promise<{ ok: true; login: LoginAnswer } | { ok: false; message: string }>;

/** The element that has focus in the page, as `tag "label"`; run in the page, so written as text. */
const FOCUSED = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return '';
  const label = el.getAttribute('aria-label') || el.getAttribute('name') || el.id || '';
  return el.tagName.toLowerCase() + (label ? ' "' + label + '"' : '');
})()`;

/** Lets the page settle after an action: navigation, scripts redrawing the page. */
async function settle(page: Page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(400);
}

/**
 * The bot's browser tools, given only to a bot with the internet on. Opening sites, reading and
 * moving around run without a card; a step marked as sending something asks the user first.
 */
export function browserTools(opts: {
  def: Define;
  bot: Bot;
  /** Where the bot's files are: an upload takes them from its own folders only. */
  dataDir: string;
  threadId: string;
  t: T;
  browser: BrowserManager;
  vault: VaultService;
  askLogin: AskLogin;
  /** What the bot noted earlier about how a site works. */
  siteNotes?: (host: string) => Promise<string[]>;
  /** Where the browser's traffic now leaves, if that changed since the bot last heard. */
  exitNote?: () => 'computer' | 'server' | null;
}): AppTool[] {
  const { def, bot, dataDir, threadId, t, browser, vault, askLogin } = opts;
  const outline = async (page: Page): Promise<string> => {
    const [title, raw, typed] = await Promise.all([
      page.title().catch(() => ''),
      page.ariaSnapshot({ mode: 'ai', timeout: 10_000 }).catch(() => ''),
      passwordValues(page),
    ]);
    // The outline shows what is typed in fields, password fields too: hide every password.
    const hidden = [...new Set([...typed, ...browser.secrets(bot.id)])]
      .filter((v) => v.length >= MIN_MASKED)
      .sort((a, b) => b.length - a.length);
    const snapshot = hidden.reduce((text, secret) => text.replaceAll(secret, MASK), raw);
    const tabs = browser.pages(bot.id)?.pages.length ?? 1;
    const body =
      snapshot.length > MAX_SNAPSHOT ? `${snapshot.slice(0, MAX_SNAPSHOT)}\n${t('browser.cut')}` : snapshot;
    return [
      t('browser.address', { url: page.url() }),
      t('browser.title', { title: title || '-' }),
      ...(tabs > 1 ? [t('browser.tabCount', { count: tabs })] : []),
      '',
      body || t('browser.emptyPage'),
    ].join('\n');
  };

  /** Runs one step in the bot's browser; browser problems come back as text the bot can act on. */
  const step = async (fn: (page: Page) => Promise<ToolResult>): Promise<ToolResult> => {
    try {
      const r = await browser.use(bot.id, fn);
      // What the page asked meanwhile (a confirm before deleting, an alert), and how it was answered.
      const asked = browser.takeDialogs(bot.id);
      // Addresses on this computer or a private network the page tried to reach, which were refused.
      const refused = browser.takeRefused(bot.id);
      // The connection the sites see changed: the person's computer came or went.
      const exit = opts.exitNote?.() ?? null;
      if (!asked.length && !refused.length && !exit) return r;
      const note = [
        ...(exit ? [t(exit === 'computer' ? 'browser.exitComputer' : 'browser.exitServer')] : []),
        ...asked.map((d) =>
          t(d.accepted ? 'browser.dialogAccepted' : 'browser.dialogDismissed', {
            type: d.type,
            message: d.message,
          }),
        ),
        ...(refused.length ? [t('browser.refusedHosts', { hosts: refused.slice(0, 5).join(', ') })] : []),
      ].join('\n');
      return typeof r === 'string' ? `${note}\n\n${r}` : { ...r, text: `${note}\n\n${r.text}` };
    } catch (err) {
      const refused = browser.takeRefused(bot.id);
      const text = browserErrorText(err, t);
      return refused.length
        ? `${t('browser.refusedHosts', { hosts: refused.slice(0, 5).join(', ') })}\n${text}`
        : text;
    }
  };
  /**
   * Runs an input on the page. With `brief`, a step that left the page where it was answers with a
   * short status instead of the whole page again: the refs of the last read stay valid, and the bot
   * reads the page when it needs to. A step that moved to another address or tab reads it at once.
   */
  const act = (fn: (page: Page) => Promise<void>, brief = false) =>
    step(async (page) => {
      const before = { url: page.url(), title: await page.title().catch(() => '') };
      await fn(page);
      await settle(page);
      // A link may have opened a new tab, which is now the active one.
      const now = browser.pages(bot.id)?.active ?? page;
      if (!brief || now !== page || now.url() !== before.url) return outline(now);
      const title = await now.title().catch(() => '');
      if (title !== before.title) return outline(now);
      const focused = await now
        .evaluate(FOCUSED)
        .then((v) => (typeof v === 'string' ? v : ''))
        .catch(() => '');
      return [
        t('browser.address', { url: now.url() }),
        t('browser.title', { title: title || '-' }),
        ...(focused ? [t('browser.focused', { element: focused })] : []),
        t('browser.unchanged'),
      ].join('\n');
    });
  const at = (page: Page, r: string) => page.locator(`aria-ref=${r}`);
  /** What the bot is told when the page is still a bot check or a refusal after the wait. */
  const wallNote = (out: ToolResult, wall: WallState): ToolResult => {
    if (wall === 'clear') return out;
    const note = t(wall === 'blocked' ? 'browser.wallBlocked' : 'browser.wallCheck');
    return typeof out === 'string' ? `${note}\n\n${out}` : { ...out, text: `${note}\n\n${out.text}` };
  };

  return [
    def(
      'browser_open',
      { url: z.string().min(1).max(2000) },
      async ({ url }) => {
        let wall: WallState = 'clear';
        const opened = await act(async (page) => {
          const res = await page.goto(webUrl(url).toString(), {
            waitUntil: 'domcontentloaded',
            timeout: 30_000,
          });
          // A "Just a moment..." page clears by itself: wait it out here, so the bot sees the site.
          wall = await waitOutWall(page, res?.status() ?? null);
        });
        const out = wallNote(opened, wall);
        // The bot's notes on this site come before the page, so it works the way that worked before.
        const host = (() => {
          try {
            return webUrl(url).hostname;
          } catch {
            return null;
          }
        })();
        const notes = host && opts.siteNotes ? await opts.siteNotes(host).catch(() => []) : [];
        if (!notes.length) return out;
        const head = `${t('browser.siteNotes', { site: host! })}\n${notes.map((n) => `- ${n}`).join('\n')}`;
        return typeof out === 'string' ? `${head}\n\n${out}` : { ...out, text: `${head}\n\n${out.text}` };
      },
      'internal',
    ),
    def('browser_snapshot', {}, async () => step(outline), 'internal'),
    def(
      'browser_click',
      { ref, element, sends, double: z.boolean().default(false) },
      async ({ ref: r, double }) =>
        act(async (page) => {
          const target = at(page, r);
          try {
            // A dry run first: a decorative layer over the element (a banner's shadow, an empty
            // overlay) makes a real click wait out its whole timeout and fail.
            await target.click({ trial: true, timeout: 3_000 });
          } catch (err) {
            if (/intercepts pointer events/i.test((err as Error).message)) {
              await target.evaluate(
                (el, n) => {
                  for (let i = 0; i < n; i++) (el as { click(): void }).click();
                },
                double ? 2 : 1,
              );
              return;
            }
          }
          await target.click({ clickCount: double ? 2 : 1 });
        }),
      'internal',
      async (a) => a.sends,
    ),
    // Saying yes to a page's confirm (delete, submit, leave) goes ahead like a click that sends, so
    // the person approves it.
    def(
      'browser_dialog',
      {
        accept: z.boolean(),
        text: z.string().max(1000).optional(),
        question: z.string().max(500).optional().describe('What the page asked, as the step result said'),
      },
      async ({ accept, text }) => {
        browser.answerNextDialog(bot.id, { accept, ...(text !== undefined && { text }) });
        return t(accept ? 'browser.dialogWillAccept' : 'browser.dialogWillDismiss');
      },
      'internal',
      async (a) => a.accept === true,
    ),
    // Menus, tooltips and row actions that only show under the pointer.
    def(
      'browser_hover',
      { ref, element },
      async ({ ref: r }) => act((page) => at(page, r).hover({ timeout: 5_000 })),
      'internal',
    ),
    def(
      'browser_type',
      {
        ref: ref.optional().describe('ref of the field; leave out to type where the page has focus'),
        element: element.optional(),
        text: z.string().max(10_000),
        submit: z.boolean().default(false),
        sends,
      },
      async ({ ref: r, text, submit }) =>
        act(async (page) => {
          if (r) {
            try {
              await at(page, r).fill(text, { timeout: 5_000 });
            } catch {
              // Not a plain field (a canvas or script-drawn editor): click into it and type.
              await at(page, r).click({ timeout: 5_000 });
              await page.keyboard.type(text);
            }
          } else {
            await page.keyboard.type(text);
          }
          if (submit) await page.keyboard.press('Enter');
        }, !submit),
      'internal',
      async (a) => a.sends,
    ),
    def(
      'browser_fill',
      {
        fields: z
          .array(z.object({ ref, element: element.optional(), text: z.string().max(10_000) }))
          .min(1)
          .max(16),
      },
      async ({ fields }) => {
        const skipped: string[] = [];
        const out = await act(async (page) => {
          for (const f of fields) {
            const field = at(page, f.ref);
            // Secrets are typed by the server from the vault, or by the person; never filled here.
            const secret = await field
              .evaluate((el) => {
                const input = el as { type?: string; autocomplete?: string };
                return (
                  input.type === 'password' ||
                  /one-time-code|cc-(number|csc|exp)/.test(input.autocomplete ?? '')
                );
              })
              .catch(() => false);
            if (secret) {
              skipped.push(f.element ?? f.ref);
              continue;
            }
            await field.fill(f.text, { timeout: 5_000 });
          }
        }, true);
        if (!skipped.length) return out;
        const note = t('browser.fillSkipped', { fields: skipped.join(', ') });
        return typeof out === 'string' ? `${note}\n\n${out}` : { ...out, text: `${note}\n\n${out.text}` };
      },
      'internal',
    ),
    def(
      'browser_upload',
      {
        ref: ref.describe('ref of the file field, or of the button that opens the file picker'),
        element,
        paths: z
          .array(z.string().min(1).max(1000))
          .min(1)
          .max(10)
          .describe('Files from your folders, relative to the working folder or absolute'),
      },
      async ({ ref: r, paths }) => {
        let files;
        try {
          files = paths.map((p) => botFile(dataDir, bot, threadId, p, t));
        } catch (err) {
          return (err as Error).message;
        }
        if (files.reduce((n, f) => n + f.size, 0) > MAX_UPLOAD_BYTES) {
          return t('browser.uploadTooBig', { max: String(MAX_UPLOAD_BYTES / 1024 / 1024) });
        }
        // Sent as bytes rather than paths: the browser may run on the bot's desktop, which cannot
        // see this server's folders.
        const payload = await Promise.all(
          files.map(async (f) => ({
            name: basename(f.full),
            mimeType: UPLOAD_TYPES[extname(f.full).toLowerCase()] ?? 'application/octet-stream',
            buffer: await readFile(f.full),
          })),
        );
        return act(async (page) => {
          const target = at(page, r);
          const isField = await target
            .evaluate((e) => {
              const el = e as unknown as { tagName: string; type?: string };
              return el.tagName === 'INPUT' && el.type === 'file';
            })
            .catch(() => false);
          if (isField) return target.setInputFiles(payload);
          // Most sites hide the field behind a button that opens the file picker.
          const [chooser] = await Promise.all([
            page.waitForEvent('filechooser', { timeout: 10_000 }),
            target.click(),
          ]);
          await chooser.setFiles(payload);
        });
      },
      'internal',
      // The files leave for the site: a card, as for any step that sends something.
      async () => true,
    ),
    def(
      'browser_login',
      {
        username_ref: ref.optional(),
        password_ref: ref.optional(),
        account: z.string().max(500).optional().describe('Which saved username, when there are several'),
        submit: z.boolean().default(true),
      },
      async ({ username_ref, password_ref, account, submit }) => {
        if (!username_ref && !password_ref) return t('browser.loginNoField');
        let host: string;
        try {
          host = await browser.use(bot.id, async (page) => {
            const url = new URL(page.url());
            if (url.protocol !== 'https:' && url.protocol !== 'http:')
              throw new BrowserError('badUrl', page.url());
            return url.hostname;
          });
        } catch (err) {
          return browserErrorText(err, t);
        }
        const saved = await vault.forHost(host, bot.id);
        let cred: { id: string | null; site: string; username: string; password: string } | undefined;
        if (account) {
          cred = saved.find((c) => c.username === account);
          if (!cred && saved.length) {
            return t('browser.loginChoose', { accounts: saved.map((c) => c.username).join(', ') });
          }
        } else if (saved.length > 1) {
          return t('browser.loginChoose', { accounts: saved.map((c) => c.username).join(', ') });
        } else cred = saved[0];
        if (!cred) {
          const site = registrableSite(host);
          const r = await askLogin(site, siteOf(host));
          if (!r.ok) return r.message;
          cred = { id: r.login.savedId, site, username: r.login.username, password: r.login.password };
        }
        const c = cred;
        return step(async (page) => {
          // The page may have moved while the user filled in the card: only type on the right site.
          const now = new URL(page.url()).hostname;
          if (!siteMatches(now, c.site)) return t('browser.loginMoved', { host: now, site: c.site });
          browser.rememberSecret(bot.id, c.password);
          if (username_ref && c.username) await at(page, username_ref).fill(c.username);
          if (password_ref) await at(page, password_ref).fill(c.password);
          if (submit) await at(page, (password_ref ?? username_ref)!).press('Enter');
          if (c.id) void vault.used(c.id).catch(() => {});
          await settle(page);
          const out = await outline(browser.pages(bot.id)?.active ?? page);
          return `${t('browser.loggedIn', { site: c.site, username: c.username || '-' })}\n\n${out}`;
        });
      },
      'internal',
    ),
    def(
      'browser_code',
      {
        ref: ref.describe('ref of the field that asks for the code'),
        account: z.string().max(500).optional().describe('Which saved username, when there are several'),
        submit: z.boolean().default(true),
      },
      async ({ ref: r, account, submit }) => {
        let host: string;
        try {
          host = await browser.use(bot.id, async (page) => new URL(page.url()).hostname);
        } catch (err) {
          return browserErrorText(err, t);
        }
        const withCode = (await vault.forHost(host, bot.id)).filter(
          (c) => c.totp && (!account || c.username === account),
        );
        if (!withCode.length) return t('browser.codeNone', { site: siteOf(host) });
        if (withCode.length > 1) {
          return t('browser.loginChoose', { accounts: withCode.map((c) => c.username).join(', ') });
        }
        const c = withCode[0]!;
        // Made on the server and typed into the page; the bot never sees it.
        const code = totp(c.totp!);
        return step(async (page) => {
          if (!siteMatches(new URL(page.url()).hostname, c.site)) {
            return t('browser.loginMoved', { host: new URL(page.url()).hostname, site: c.site });
          }
          browser.rememberSecret(bot.id, code);
          await at(page, r).fill(code);
          if (submit) await at(page, r).press('Enter');
          void vault.used(c.id).catch(() => {});
          await settle(page);
          const out = await outline(browser.pages(bot.id)?.active ?? page);
          return `${t('browser.codeTyped', { site: c.site })}\n\n${out}`;
        });
      },
      'internal',
    ),
    def(
      'browser_select',
      { ref, element, values: z.array(z.string().max(500)).min(1).max(20) },
      async ({ ref: r, values }) =>
        act(async (page) => {
          await at(page, r).selectOption(values);
        }, true),
      'internal',
    ),
    def(
      'browser_press',
      { key: z.string().min(1).max(40).describe('e.g. Enter, Escape, Tab, ArrowDown, Control+a'), sends },
      async ({ key }) => act((page) => page.keyboard.press(key), true),
      'internal',
      async (a) => a.sends,
    ),
    def(
      'browser_scroll',
      { direction: z.enum(['up', 'down']), pages: z.number().min(0.25).max(10).default(1) },
      async ({ direction, pages }) =>
        act(async (page) => {
          await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2);
          await page.mouse.wheel(0, (direction === 'down' ? 1 : -1) * pages * VIEWPORT.height * 0.8);
        }),
      'internal',
    ),
    def(
      'browser_history',
      { action: z.enum(['back', 'forward', 'reload']) },
      async ({ action }) =>
        act(async (page) => {
          if (action === 'back') await page.goBack();
          else if (action === 'forward') await page.goForward();
          else await page.reload();
        }),
      'internal',
    ),
    def(
      'browser_tabs',
      {
        action: z.enum(['list', 'select', 'new', 'close']),
        index: z.number().int().min(1).max(50).optional(),
        url: z.string().max(2000).optional(),
      },
      async ({ action, index, url }) =>
        step(async () => {
          const list = () => {
            const s = browser.pages(bot.id);
            if (!s) return t('browser.noTabs');
            return s.pages
              .map((p, i) => `${i + 1}. ${p.url()}${p === s.active ? ` ${t('browser.activeTab')}` : ''}`)
              .join('\n');
          };
          if (action === 'list') return list();
          if (action === 'new') {
            const page = await browser.newPage(bot.id);
            let wall: WallState = 'clear';
            if (url) {
              const res = await page.goto(webUrl(url).toString(), {
                waitUntil: 'domcontentloaded',
                timeout: 30_000,
              });
              wall = await waitOutWall(page, res?.status() ?? null);
            }
            await settle(page);
            return wallNote(await outline(page), wall);
          }
          const target = index ? browser.pages(bot.id)?.pages[index - 1] : undefined;
          if (!target) return `${t('browser.noSuchTab')}\n${list()}`;
          if (action === 'close') {
            await target.close();
            return list();
          }
          browser.select(bot.id, target);
          await target.bringToFront().catch(() => {});
          return outline(target);
        }),
      'internal',
    ),
    def(
      'browser_screenshot',
      {
        ref: ref.optional().describe('ref of one element to picture alone; leave out for the whole view'),
        save_as: z
          .string()
          .regex(/^[\w .-]{1,80}\.jpe?g$/i)
          .optional()
          .describe('file name to also keep the picture in the conversation folder, e.g. "fiyatlar.jpg"'),
      },
      async ({ ref: r, save_as }) =>
        step(async (page) => {
          // In page points: a sharper screen would only make the picture larger, not clearer to the bot.
          const options = { type: 'jpeg', quality: 70, timeout: 15_000, scale: 'css' } as const;
          const shot = r ? await at(page, r).screenshot(options) : await page.screenshot(options);
          let saved = '';
          if (save_as) {
            // Into the conversation folder, where send_file and the person's library find it.
            const dir = workspacePaths(dataDir, bot.id, threadId, bot.groupId).threadDir;
            const file = join(dir, basename(save_as));
            await writeFile(file, shot);
            saved = `\n${t('browser.screenshotSaved', { path: file })}`;
          }
          return {
            text: `${t('browser.screenshot', { url: page.url() })}${saved}`,
            images: [{ data: shot.toString('base64'), mimeType: 'image/jpeg' }],
          };
        }),
      'internal',
    ),
    def(
      'browser_wait',
      { text: z.string().max(200).optional(), seconds: z.number().min(0.5).max(30).optional() },
      async ({ text, seconds }) =>
        step(async (page) => {
          if (text) {
            const found = await page
              .getByText(text)
              .first()
              .waitFor({ timeout: (seconds ?? 20) * 1000 })
              .then(
                () => true,
                () => false,
              );
            if (!found) return t('browser.textNotFound', { text });
          } else await page.waitForTimeout((seconds ?? 2) * 1000);
          return outline(page);
        }),
      'internal',
    ),
  ];
}
