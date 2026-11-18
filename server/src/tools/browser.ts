import { readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { Bot } from '@yumakbot/shared';
import { BrowserError } from '../browser/manager';
import type { ElementHandle, Frame, Page, Route } from 'playwright-core';
import { z } from 'zod';
import { VIEWPORT, webUrl, type BrowserManager } from '../browser/manager';
import {
  formatMessages,
  formatRequests,
  MASK,
  requestFailed,
  safeUrl,
  type PageLog,
  SHOWN_MESSAGES,
  SHOWN_REQUESTS,
} from '../browser/logs';
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

/** Shorter values are not masked in free text: they would hide ordinary letters and words. */
const MIN_MASKED = 4;

/** Every form a secret takes in what a page shows: as typed, in an address, in a form's body. */
function secretForms(secret: string): string[] {
  const forms = new Set([
    secret,
    encodeURIComponent(secret),
    new URLSearchParams([['', secret]]).toString().slice(1),
    JSON.stringify(secret).slice(1, -1),
  ]);
  return [...forms];
}

/**
 * `text` with every secret taken out, also where an address or a title carries it encoded.
 * Longer ones go first, so one secret inside another is not left half shown.
 */
export function maskSecrets(text: string, secrets: readonly string[]): string {
  const forms = [...new Set(secrets.filter((v) => v.length >= MIN_MASKED).flatMap(secretForms))].sort(
    (a, b) => b.length - a.length,
  );
  return forms.reduce((out, f) => out.replaceAll(f, MASK), text);
}

/**
 * Runs in each frame: what the page shows as text, its address and title, and the values of its
 * fields that are not password fields (a "show password" switch turns one into plain text).
 */
const SHOWN_TEXT = `(() => {
  const fields = [...document.querySelectorAll('input, textarea')]
    .filter((e) => (e.type || '').toLowerCase() !== 'password')
    .map((e) => e.value || '');
  return [location.href, document.title, document.body ? document.body.innerText : '', ...fields].join('\\n');
})()`;

/** Whether a vault secret is in plain sight on the page, where a picture of it would show it. */
async function secretShown(page: Page, secrets: readonly string[]): Promise<boolean> {
  const list = secrets.filter((v) => v.length >= MIN_MASKED);
  if (!list.length) return false;
  const shown = await Promise.all(
    page.frames().map((f) =>
      f
        .evaluate(SHOWN_TEXT)
        .then((v) => `${f.url()}\n${typeof v === 'string' ? v : ''}`)
        .catch(() => f.url()),
    ),
  );
  const text = [page.url(), ...shown].join('\n');
  return list.some((secret) => secretForms(secret).some((f) => text.includes(f)));
}

/**
 * Words on a control that sends, posts, buys, books, deletes or shares something, matched on what
 * the page itself shows rather than on what the bot says the control is.
 */
const SEND_WORDS = {
  en: /\b(send|submit|post|publish|tweet|reply|comment|share|buy|purchase|order|checkout|check out|pay|book|reserve|confirm|delete|remove|transfer|donate|subscribe|unsubscribe|apply|invite|follow|like)\b/i,
  tr: /(?<!\p{L})(gönder|paylaş|yayınla|yayımla|sil|kaldır|satın al|öde|sipariş|onayla|rezervasyon|rezerve|yanıtla|cevapla|yorum yap|aktar|bağış|abone|başvur|davet|takip et|beğen)/iu,
};

/** Whether a control's words say it sends something. */
export function sendWords(label: string): boolean {
  return Object.values(SEND_WORDS).some((re) => re.test(label));
}

/** What a click on an element would set off, as far as the page shows it. */
export interface ControlInfo {
  /** The element is, or sits in, a button, link, field or other control. */
  control: boolean;
  /** It submits a form. */
  submits: boolean;
  /** How the form it submits, or the field is part of, is sent: get, post or dialog; '' for none. */
  method: string;
  /** Its words: label, text or value. */
  label: string;
  /** A field where Enter may send what was written: a text area or an editable area. */
  writes: boolean;
  /** A one-line field and whether it searches. */
  field: boolean;
  search: boolean;
}

/** Runs in the page, on the element itself; written as a function the page receives as text. */
const controlInfo = (node: unknown): ControlInfo => {
  type El = {
    tagName: string;
    type?: string;
    value?: unknown;
    innerText?: string;
    isContentEditable?: boolean;
    form?: { method: string } | null;
    getAttribute(name: string): string | null;
    closest(selector: string): El | null;
  };
  const el = node as El;
  const found = el.closest(
    'button,input,select,textarea,a[href],summary,[contenteditable=""],[contenteditable="true"],[role=button],[role=link],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],[role=tab],[role=option],[role=switch],[role=checkbox],[role=textbox],[role=searchbox],[role=combobox]',
  );
  const c = found ?? el;
  const tag = c.tagName.toLowerCase();
  const attr = (n: string) => (c.getAttribute(n) || '').toLowerCase();
  const type = (typeof c.type === 'string' ? c.type : attr('type')).toLowerCase();
  const submitter =
    (tag === 'button' && type === 'submit') || (tag === 'input' && (type === 'submit' || type === 'image'));
  const field =
    tag === 'input' &&
    !submitter &&
    !['checkbox', 'radio', 'button', 'reset', 'file', 'hidden', 'range', 'color'].includes(type);
  const form = submitter || field ? (c.form ?? null) : null;
  const words = (
    c.getAttribute('aria-label') ||
    (tag === 'input' ? '' : c.innerText) ||
    (typeof c.value === 'string' ? c.value : '') ||
    c.getAttribute('title') ||
    ''
  )
    .trim()
    .replace(/\s+/g, ' ');
  const name = `${attr('name')} ${attr('id')} ${attr('placeholder')} ${attr('aria-label')}`;
  return {
    control: !!found,
    submits: submitter && !!form,
    method: form ? ((submitter && attr('formmethod')) || form.method || 'get').toLowerCase() : '',
    label: words.length > 80 ? '' : words,
    writes: tag === 'textarea' || !!c.isContentEditable,
    field,
    search:
      type === 'search' ||
      ['searchbox', 'combobox'].includes(attr('role')) ||
      !!c.closest('[role=search]') ||
      /search|query|\bara\b|^q\b|^s\b/.test(name),
  };
};

/** Whether a click on this control sends something: a form posted, or words that say so. */
export function clickSends(c: ControlInfo): boolean {
  if (!c.control) return false;
  if (c.submits && c.method === 'post') return true;
  return sendWords(c.label);
}

/**
 * Whether pressing Enter where this control has the focus sends something. A one-line field sends
 * its form; one that searches only reads. A text area or an editable area is where chats and mail
 * send on Enter. Null means nothing has the focus.
 */
export function enterSends(c: ControlInfo | null): boolean {
  if (!c) return false;
  if (c.writes) return true;
  // A form sent with get reads (a search, a filter); a field with no form is read by the page's
  // own script, which sends on Enter unless the field is plainly a search.
  if (c.field) return c.method ? c.method === 'post' : !c.search;
  return clickSends(c);
}

/** Keys that paste: what is pasted may have been copied from another site's page. */
const PASTE = /^(control|meta|controlormeta)\+v$|^shift\+insert$/i;

/** Whether a key press sends something by the key alone, whatever has the focus. */
export function keySends(key: string): boolean | null {
  const keys = key.replace(/\s+/g, '');
  if (PASTE.test(keys)) return true;
  const parts = keys.toLowerCase().split('+');
  const main = parts.at(-1) ?? '';
  // Control+Enter and Command+Enter send a message or a mail in most sites that have them.
  if (main.endsWith('enter') && parts.slice(0, -1).some((m) => /^(control|meta|controlormeta)$/.test(m)))
    return true;
  // Enter and Space act on what has the focus: the page decides.
  if (main.endsWith('enter') || main === 'space' || key === ' ') return null;
  return false;
}

/** The kinds of field a vault secret may go into. */
type FieldKind = 'username' | 'password' | 'code';
/** Input types each kind of field may have; a password goes into a password field only. */
const FIELD_TYPES: Record<FieldKind, readonly string[]> = {
  username: ['text', 'email', 'tel'],
  password: ['password'],
  code: ['text', 'tel', 'number', 'password'],
};

/** Runs in the page, on a field: its kind, and every address its form may send it to. */
const fieldInfo = (node: unknown) => {
  type El = {
    tagName: string;
    type?: unknown;
    formAction?: unknown;
    form?: { action: string; elements: ArrayLike<El> } | null;
    getAttribute(name: string): string | null;
    hasAttribute(name: string): boolean;
    closest(selector: string): El | null;
  };
  const el = node as El;
  const attr = (n: string) => (el.getAttribute(n) || '').toLowerCase();
  const actions: string[] = [];
  if (el.form) {
    actions.push(el.form.action);
    // A button may send the form somewhere else than the form says.
    for (const c of Array.from(el.form.elements)) {
      if (c.hasAttribute('formaction') && typeof c.formAction === 'string') actions.push(c.formAction);
    }
  }
  const name = `${attr('name')} ${attr('id')} ${attr('placeholder')} ${attr('aria-label')}`;
  return {
    tag: el.tagName.toLowerCase(),
    type: typeof el.type === 'string' ? el.type.toLowerCase() : attr('type') || 'text',
    actions,
    search:
      attr('type') === 'search' ||
      attr('role') === 'searchbox' ||
      !!el.closest('[role=search]') ||
      /search|query|\bara\b|^q\b|^s\b/.test(name),
  };
};

/**
 * Runs in each frame: whether something in it has the focus. `frame` means the focus is in a
 * frame inside it.
 */
const FOCUS_STATE = `(() => {
  const a = document.activeElement;
  if (!document.hasFocus() || !a || a === document.body || a === document.documentElement) return 'none';
  return /^i?frame$/i.test(a.tagName) ? 'frame' : 'element';
})()`;

/**
 * What has the focus in the page, looked for in every frame. `unknown` when the focus is in a frame
 * that cannot be read: a key pressed there is taken as one that may send.
 */
async function focusInfo(page: Page): Promise<ControlInfo | null | 'unknown'> {
  let inFrame = false;
  for (const frame of page.frames()) {
    const state = await frame.evaluate(FOCUS_STATE).catch(() => 'none');
    if (state === 'frame') inFrame = true;
    if (state !== 'element') continue;
    const handle = await frame.evaluateHandle('document.activeElement').catch(() => null);
    const el = handle?.asElement() ?? null;
    if (!el) {
      await handle?.dispose().catch(() => {});
      continue;
    }
    try {
      return await el.evaluate(controlInfo);
    } catch {
      return 'unknown';
    } finally {
      await el.dispose().catch(() => {});
    }
  }
  return inFrame ? 'unknown' : null;
}

/** How long a step the server took as sending may send once it runs: the card may wait a while. */
const ALLOW_MS = 60 * 60_000;
/** A two-step code is good for a minute or two; it stays hidden from what the bot reads this long. */
const CODE_HIDDEN_MS = 10 * 60_000;

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
  /** Whom the bot works for: only the team's sign-ins and theirs are typed. */
  person: string;
  askLogin: AskLogin;
  /** What the bot noted earlier about how a site works. */
  siteNotes?: (host: string) => Promise<string[]>;
  /** Where the browser's traffic now leaves, if that changed since the bot last heard. */
  exitNote?: () => 'computer' | 'server' | null;
}): AppTool[] {
  const { def, bot, dataDir, threadId, t, browser, vault, person, askLogin } = opts;
  const outline = async (page: Page): Promise<string> => {
    const [title, raw, typed] = await Promise.all([
      page.title().catch(() => ''),
      page.ariaSnapshot({ mode: 'ai', timeout: 10_000 }).catch(() => ''),
      passwordValues(page),
    ]);
    const tabs = browser.pages(bot.id)?.pages.length ?? 1;
    const body = raw.length > MAX_SNAPSHOT ? `${raw.slice(0, MAX_SNAPSHOT)}\n${t('browser.cut')}` : raw;
    // The outline shows what is typed in fields, password fields too, and a form sent with get
    // carries them in the address and the title: hide every password, wherever it shows.
    return maskSecrets(
      [
        t('browser.address', { url: page.url() }),
        t('browser.title', { title: title || '-' }),
        ...(tabs > 1 ? [t('browser.tabCount', { count: tabs })] : []),
        '',
        body || t('browser.emptyPage'),
      ].join('\n'),
      [...typed, ...browser.secrets(bot.id)],
    );
  };
  /** A step's result with every vault secret taken out, whatever part of the page carried it. */
  const hide = (r: ToolResult): ToolResult => {
    const secrets = browser.secrets(bot.id);
    if (!secrets.length) return r;
    return typeof r === 'string' ? maskSecrets(r, secrets) : { ...r, text: maskSecrets(r.text, secrets) };
  };

  /** Runs one step in the bot's browser; browser problems come back as text the bot can act on. */
  const step = async (fn: (page: Page) => Promise<ToolResult>): Promise<ToolResult> => {
    try {
      const r = hide(await browser.use(bot.id, fn));
      // What the page asked meanwhile (a confirm before deleting, an alert), and how it was answered.
      const asked = browser.takeDialogs(bot.id);
      // Addresses on this computer or a private network the page tried to reach, which were refused.
      const refused = browser.takeRefused(bot.id);
      // The connection the sites see changed: the person's computer came or went.
      const exit = opts.exitNote?.() ?? null;
      // Tabs the site closed itself while the bot was on them.
      const closed = browser.takeClosedTabs(bot.id);
      if (!asked.length && !refused.length && !exit && !closed.length) return r;
      const note = [
        ...(exit ? [t(exit === 'computer' ? 'browser.exitComputer' : 'browser.exitServer')] : []),
        ...closed.map((url) => t('browser.tabClosedBySite', { url: url || '-' })),
        ...asked.map((d) =>
          t(d.accepted ? 'browser.dialogAccepted' : 'browser.dialogDismissed', {
            type: d.type,
            message: d.message,
          }),
        ),
        ...(refused.length ? [t('browser.refusedHosts', { hosts: refused.slice(0, 5).join(', ') })] : []),
      ].join('\n');
      // The page's own questions may quote what was typed into it.
      return hide(typeof r === 'string' ? `${note}\n\n${r}` : { ...r, text: `${note}\n\n${r.text}` });
    } catch (err) {
      const refused = browser.takeRefused(bot.id);
      const text = maskSecrets(browserErrorText(err, t), browser.secrets(bot.id));
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
  const act = (fn: (page: Page) => Promise<void>, brief = false, hold = false) =>
    step(async (page) => {
      const before = { url: page.url(), title: await page.title().catch(() => '') };
      const held = await holding(page, hold, async () => {
        await fn(page);
        await settle(page);
      });
      const out = await (async () => {
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
      })();
      return held ? `${t('browser.sendHeld')}\n\n${out}` : out;
    });
  /**
   * Runs a step that was not approved as one that sends. A form the page sends meanwhile (the step
   * pressed its button, or the page's script sent it on a change) is cancelled before it reaches
   * the site. A cancelled page load shows no error page, so the page stays as it was, with what was
   * typed in it. Says whether one was.
   */
  const holding = async (page: Page, hold: boolean, run: () => Promise<void>): Promise<boolean> => {
    if (!hold) {
      await run();
      return false;
    }
    let held = false;
    const context = page.context();
    const stop = (route: Route) => {
      const r = route.request();
      if (r.isNavigationRequest() && r.method() !== 'GET') {
        held = true;
        return route.abort('aborted');
      }
      return route.fallback();
    };
    await context.route('**/*', stop);
    try {
      await run();
    } finally {
      await context.unroute('**/*', stop).catch(() => {});
    }
    return held;
  };
  /** Steps the server took as sending, by their input, with when; their run may send. */
  const allowed = new Map<string, number>();
  const callKey = (name: string, a: unknown) => `${name} ${JSON.stringify(a)}`;
  /** Whether this run of a step was let through as one that sends; each approval is used once. */
  const maySend = (name: string, a: { sends?: boolean }) => {
    const key = callKey(name, a);
    const when = allowed.get(key);
    allowed.delete(key);
    return a.sends === true || (when !== undefined && Date.now() - when < ALLOW_MS);
  };
  /**
   * Looks at the page before a step. With no browser open there is nothing to send; a page that
   * cannot be read is taken as one that may send.
   */
  const looks = async (fn: (page: Page) => Promise<boolean>): Promise<boolean> => {
    if (!browser.pages(bot.id)) return false;
    try {
      return await browser.use(bot.id, fn);
    } catch (err) {
      return !(err instanceof BrowserError);
    }
  };
  /**
   * Whether a step needs the person's approval: the bot says it sends, or the page shows it does,
   * whatever the bot said (a form posted, a "Send" button, Enter in a message box). What the bot
   * read may steer it, so its own word cannot be the only gate.
   */
  const gate =
    <A extends { sends?: boolean }>(name: string, seen: (page: Page, a: A) => Promise<boolean>) =>
    async (a: A): Promise<boolean> => {
      const sends = a.sends === true || (await looks((page) => seen(page, a)));
      if (sends) {
        const now = Date.now();
        for (const [k, when] of allowed) if (now - when >= ALLOW_MS) allowed.delete(k);
        allowed.set(callKey(name, a), now);
      }
      return sends;
    };
  const at = (page: Page, r: string) => page.locator(`aria-ref=${r}`);
  const control = (page: Page, r: string) => at(page, r).evaluate(controlInfo, undefined, { timeout: 2_000 });
  /** Whether Enter pressed in this field, or where the focus is, sends something. */
  const enterSendsAt = async (page: Page, r?: string) => {
    if (r) return enterSends(await control(page, r));
    const focus = await focusInfo(page);
    return focus === 'unknown' || enterSends(focus);
  };
  /** Whether an address may carry sign-in details: https, or plain http on this computer. */
  const secure = (u: URL) =>
    u.protocol === 'https:' || (u.protocol === 'http:' && browser.localHost(u.hostname));
  const parsed = (raw: string): URL | null => {
    try {
      return new URL(raw);
    } catch {
      return null;
    }
  };
  /**
   * The field a vault secret goes into: the kind of field asked for, in a frame of the saved site
   * itself over https (not another site's frame inside its page), and in a form that sends to that
   * site. Otherwise the reason it is not, for the bot.
   */
  const secretField = async (
    page: Page,
    r: string,
    kind: FieldKind,
    site: string,
  ): Promise<{ field: ElementHandle } | { refused: string }> => {
    const field = await at(page, r).elementHandle({ timeout: 5_000 });
    const refuse = async (refused: string) => {
      await field.dispose().catch(() => {});
      return { refused };
    };
    const info = await field.evaluate(fieldInfo);
    if (
      info.tag !== 'input' ||
      (kind !== 'password' && info.search) ||
      !FIELD_TYPES[kind].includes(info.type)
    ) {
      return refuse(
        t(
          kind === 'password'
            ? 'browser.loginNotPassword'
            : kind === 'username'
              ? 'browser.loginNotUsername'
              : 'browser.codeNotField',
        ),
      );
    }
    // The frame's address, from the browser itself: a page cannot make its frame look like another.
    const frame: Frame | null = await field.ownerFrame();
    const where = parsed(frame?.url() ?? '');
    if (!where || !secure(where) || !siteMatches(where.hostname, site)) {
      return refuse(t('browser.loginFrame', { origin: where?.origin ?? '-', site }));
    }
    for (const action of info.actions) {
      const to = parsed(action);
      // A form a script sends never goes to its action.
      if (to?.protocol === 'javascript:') continue;
      if (!to || !secure(to) || !siteMatches(to.hostname, site)) {
        return refuse(t('browser.loginAction', { target: to?.origin ?? action.slice(0, 100), site }));
      }
    }
    return { field };
  };
  /** What the bot is told when the page is still a bot check or a refusal after the wait. */
  const wallNote = (out: ToolResult, wall: WallState): ToolResult => {
    if (wall === 'clear') return out;
    const note = t(wall === 'blocked' ? 'browser.wallBlocked' : 'browser.wallCheck');
    return typeof out === 'string' ? `${note}\n\n${out}` : { ...out, text: `${note}\n\n${out.text}` };
  };
  const logTab = z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('tab number from browser_tabs; leave out for the active tab');
  const forget = z.boolean().default(false).describe('forget what was recorded so far, after reading it');
  /**
   * Reads one tab's record of requests or console messages. Never starts a browser: with none open
   * there is nothing recorded.
   */
  const readLog = (tab: number | undefined, read: (page: Page, log: PageLog) => string) => {
    if (!browser.pages(bot.id)) return Promise.resolve<ToolResult>(t('browser.noTabs'));
    return step(async (active) => {
      const page = tab ? browser.pages(bot.id)?.pages[tab - 1] : active;
      const log = page ? browser.log(bot.id, page) : null;
      if (!page || !log) return t('browser.noSuchTab');
      return `${t('browser.logTab', { url: safeUrl(page.url()) })}\n${read(page, log)}`;
    });
  };
  /** The lines of a log reply after its entries: what was left out, and whether it was forgotten. */
  const logNotes = (older: number, dropped: number, cleared: boolean) =>
    [
      ...(older > 0 ? [t('browser.logOlder', { count: older })] : []),
      ...(dropped > 0 ? [t('browser.logDropped', { count: dropped })] : []),
      ...(cleared ? [t('browser.logCleared')] : []),
    ]
      .map((line) => `\n${line}`)
      .join('');

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
      async (a) => {
        const { ref: r, double } = a;
        const hold = !maySend('browser_click', a);
        return act(
          async (page) => {
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
          },
          false,
          hold,
        );
      },
      'internal',
      gate('browser_click', async (page, a) => clickSends(await control(page, a.ref))),
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
      async ({ ref: r }) => act((page) => at(page, r).hover({ timeout: 5_000 }), false, true),
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
      async (a) => {
        const { ref: r, text, submit } = a;
        const hold = !maySend('browser_type', a);
        return act(
          async (page) => {
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
          },
          !submit,
          hold,
        );
      },
      'internal',
      // Typing alone sends nothing; Enter (asked for, or a line break typed as keys) may.
      gate('browser_type', async (page, a) =>
        a.submit || /[\r\n]/.test(a.text) ? enterSendsAt(page, a.ref) : false,
      ),
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
        const out = await act(
          async (page) => {
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
            // Filling sends nothing; a page that sends its form on a change waits for a step that does.
          },
          true,
          true,
        );
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
          const url = await browser.use(bot.id, async (page) => {
            const url = new URL(page.url());
            if (url.protocol !== 'https:' && url.protocol !== 'http:')
              throw new BrowserError('badUrl', page.url());
            return url;
          });
          // Over plain http anyone on the way reads the password: it is not typed, nor asked for.
          if (!secure(url)) return t('browser.loginInsecure');
          host = url.hostname;
        } catch (err) {
          return browserErrorText(err, t);
        }
        const saved = await vault.forHost(host, bot.id, person);
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
          const now = new URL(page.url());
          if (!siteMatches(now.hostname, c.site)) {
            return t('browser.loginMoved', { host: now.hostname, site: c.site });
          }
          if (!secure(now)) return t('browser.loginInsecure');
          // Each value goes only into a field of its own kind, on the saved site itself: a ref may
          // name a search box, a comment field, or a frame of another site inside the page.
          const fields: ElementHandle[] = [];
          try {
            let user: ElementHandle | null = null;
            let pass: ElementHandle | null = null;
            if (username_ref && c.username) {
              const f = await secretField(page, username_ref, 'username', c.site);
              if ('refused' in f) return f.refused;
              fields.push((user = f.field));
            }
            if (password_ref) {
              const f = await secretField(page, password_ref, 'password', c.site);
              if ('refused' in f) return f.refused;
              fields.push((pass = f.field));
            }
            browser.rememberSecret(bot.id, c.password);
            if (user) await user.fill(c.username);
            if (pass) await pass.fill(c.password);
            const last = pass ?? user;
            if (submit) await (last ? last.press('Enter') : at(page, username_ref!).press('Enter'));
          } finally {
            for (const f of fields) await f.dispose().catch(() => {});
          }
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
          const url = await browser.use(bot.id, async (page) => new URL(page.url()));
          if (!secure(url)) return t('browser.loginInsecure');
          host = url.hostname;
        } catch (err) {
          return browserErrorText(err, t);
        }
        const withCode = (await vault.forHost(host, bot.id, person)).filter(
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
          const now = new URL(page.url());
          if (!siteMatches(now.hostname, c.site)) {
            return t('browser.loginMoved', { host: now.hostname, site: c.site });
          }
          if (!secure(now)) return t('browser.loginInsecure');
          const f = await secretField(page, r, 'code', c.site);
          if ('refused' in f) return f.refused;
          try {
            browser.rememberSecret(bot.id, code, CODE_HIDDEN_MS);
            await f.field.fill(code);
            if (submit) await f.field.press('Enter');
          } finally {
            await f.field.dispose().catch(() => {});
          }
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
        act(
          async (page) => {
            await at(page, r).selectOption(values);
          },
          true,
          // Choosing sends nothing; a page that sends its form on a change waits for a step that does.
          true,
        ),
      'internal',
    ),
    def(
      'browser_press',
      { key: z.string().min(1).max(40).describe('e.g. Enter, Escape, Tab, ArrowDown, Control+a'), sends },
      async (a) => {
        const hold = !maySend('browser_press', a);
        return act((page) => page.keyboard.press(a.key), true, hold);
      },
      'internal',
      gate('browser_press', async (page, a) => {
        const byKey = keySends(a.key);
        if (byKey !== null) return byKey;
        const focus = await focusInfo(page);
        if (focus === 'unknown') return true;
        // Enter sends what a field holds; Space presses the button that has the focus.
        return /enter$/i.test(a.key) ? enterSends(focus) : !!focus && clickSends(focus);
      }),
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
            await browser.closePage(bot.id, target);
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
          // Text can be masked, a picture cannot: none is taken while a vault secret shows in plain
          // text (a "show password" switch, a field it was typed into, the address).
          if (await secretShown(page, browser.secrets(bot.id))) return t('browser.screenshotSecret');
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
    // Why a page does not work as it should: a request that failed or came back with an error.
    def(
      'browser_network',
      {
        tab: logTab,
        filter: z.string().max(200).optional().describe('only requests whose address contains this'),
        failed: z
          .boolean()
          .default(false)
          .describe('only requests that failed or got a status of 400 or more'),
        clear: forget,
      },
      async ({ tab, filter, failed, clear }) =>
        readLog(tab, (_page, log) => {
          const needle = filter?.toLowerCase();
          const matching = log.requests.filter(
            (e) => (!failed || requestFailed(e)) && (!needle || e.url.toLowerCase().includes(needle)),
          );
          const shown = matching.slice(-SHOWN_REQUESTS);
          const dropped = log.droppedRequests;
          if (clear) log.clearRequests();
          const body = shown.length ? formatRequests(shown, t) : t('browser.netNone');
          return body + logNotes(matching.length - shown.length, dropped, clear);
        }),
      'internal',
    ),
    // What the page's scripts logged, and the errors they did not catch.
    def(
      'browser_console',
      {
        tab: logTab,
        errors: z.boolean().default(false).describe('only errors and warnings'),
        clear: forget,
      },
      async ({ tab, errors, clear }) =>
        readLog(tab, (_page, log) => {
          const matching = log.messages.filter(
            (e) => !errors || e.level === 'error' || e.level === 'warning',
          );
          const shown = matching.slice(-SHOWN_MESSAGES);
          const dropped = log.droppedMessages;
          if (clear) log.clearMessages();
          const body = shown.length ? formatMessages(shown, t) : t('browser.consoleNone');
          return body + logNotes(matching.length - shown.length, dropped, clear);
        }),
      'internal',
    ),
  ];
}
