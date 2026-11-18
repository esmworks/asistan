import type { ConsoleMessage, Page, Request } from 'playwright-core';
import type { T } from '../i18n';

/**
 * What a tab of the bot's browser sent and logged, so the bot can tell why a page does not work:
 * a request that failed or came back with an error, a script error in the console. Only what a
 * request was is kept (method, address, status, type, time); bodies and header values are not,
 * since cookies, sign-in headers and tokens travel there and the bot never saw them on the page.
 */

/** Shown instead of a password, a token or another secret anywhere in what the bot reads. */
export const MASK = '••••••';

/** Requests and console messages kept per tab; older ones are let go. */
export const MAX_REQUESTS = 300;
export const MAX_MESSAGES = 200;
/** Longest address and console text kept: a `data:` address or a dumped object would fill the reply. */
const MAX_URL = 300;
const MAX_TEXT = 1000;

export interface NetEntry {
  id: number;
  method: string;
  url: string;
  /** document, script, fetch, xhr, image, ... */
  type: string;
  /** Null until the answer came. */
  status: number | null;
  /** Why it failed (`net::ERR_...`), when it did. */
  failure: string | null;
  /** How long it took, once it finished or failed. */
  ms: number | null;
}

export type ConsoleLevel = 'error' | 'warning' | 'info' | 'log' | 'debug';

export interface ConsoleEntry {
  id: number;
  level: ConsoleLevel;
  text: string;
  /** Where in which script it was logged, `address:line`. */
  where: string | null;
  /** An error the page's script did not catch. */
  uncaught: boolean;
}

/** One tab's record: the latest requests and console messages, numbered in the order they came. */
export class PageLog {
  requests: NetEntry[] = [];
  messages: ConsoleEntry[] = [];
  /** How many were let go because the record was full, since it was last cleared. */
  droppedRequests = 0;
  droppedMessages = 0;
  private next = 1;

  addRequest(e: Omit<NetEntry, 'id'>): NetEntry {
    const entry = { id: this.next++, ...e };
    this.requests.push(entry);
    if (this.requests.length > MAX_REQUESTS) {
      this.requests.shift();
      this.droppedRequests++;
    }
    return entry;
  }

  addMessage(e: Omit<ConsoleEntry, 'id'>): ConsoleEntry {
    const entry = { id: this.next++, ...e };
    this.messages.push(entry);
    if (this.messages.length > MAX_MESSAGES) {
      this.messages.shift();
      this.droppedMessages++;
    }
    return entry;
  }

  clearRequests() {
    this.requests = [];
    this.droppedRequests = 0;
  }

  clearMessages() {
    this.messages = [];
    this.droppedMessages = 0;
  }
}

/**
 * Query parameters whose value is hidden: parts of the name that mean a secret, and short names
 * used for one (an OAuth `code`, a signed link's `sig`).
 */
const SECRET_PARAM =
  /token|secret|passw|pwd|api[-_]?key|apikey|signature|session|credential|auth(?!or)|jwt|otp|cookie/i;
const SECRET_NAMES = new Set(['key', 'sig', 'sid', 'code', 'pass', 'ticket', 'state', 'nonce', 'hash']);

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * An address as the bot may read it: no user name or password in it, no fragment, the value of a
 * parameter that may carry a secret hidden, and cut to a readable length.
 */
export function safeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return clip(raw, MAX_URL);
  }
  if (
    url.protocol !== 'http:' &&
    url.protocol !== 'https:' &&
    url.protocol !== 'ws:' &&
    url.protocol !== 'wss:'
  ) {
    // data: and blob: addresses carry their whole content; their kind is enough.
    return clip(raw, 60);
  }
  url.username = '';
  url.password = '';
  url.hash = '';
  const hidden: string[] = [];
  for (const name of new Set(url.searchParams.keys())) {
    if (SECRET_PARAM.test(name) || SECRET_NAMES.has(name.toLowerCase())) hidden.push(name);
  }
  for (const name of hidden) url.searchParams.set(name, MASK);
  // URLSearchParams writes the mask percent-encoded; it reads better as itself.
  return clip(url.toString().replaceAll(encodeURIComponent(MASK), MASK), MAX_URL);
}

/** Tokens a script may print to the console: a JWT, a bearer header. */
const TOKEN_TEXT = [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, /\b(bearer|basic)\s+[\w~+/.=-]{8,}/gi];

/** Console text as the bot may read it: tokens it plainly shows hidden, addresses made safe, cut. */
export function safeText(text: string): string {
  let out = text.replace(/\bhttps?:\/\/[^\s"'<>)]+/g, (u) => safeUrl(u));
  for (const re of TOKEN_TEXT)
    out = out.replace(re, (m) => (/^(bearer|basic)\s/i.test(m) ? `${m.split(/\s/)[0]} ${MASK}` : MASK));
  return clip(out, MAX_TEXT);
}

function level(type: string): ConsoleLevel {
  if (type === 'error' || type === 'assert') return 'error';
  if (type === 'warning') return 'warning';
  if (type === 'info' || type === 'debug') return type;
  return 'log';
}

/** Starts recording a tab; the record lives as long as the tab. */
export function watchPage(page: Page): PageLog {
  const log = new PageLog();
  const open = new WeakMap<Request, { entry: NetEntry; at: number }>();
  const done = (r: Request, failure: string | null) => {
    const o = open.get(r);
    if (!o) return;
    open.delete(r);
    o.entry.ms = Date.now() - o.at;
    if (failure) o.entry.failure = failure;
  };
  page.on('request', (r) => {
    const entry = log.addRequest({
      method: r.method(),
      url: safeUrl(r.url()),
      type: r.resourceType(),
      status: null,
      failure: null,
      ms: null,
    });
    open.set(r, { entry, at: Date.now() });
  });
  page.on('response', (res) => {
    const o = open.get(res.request());
    if (o) o.entry.status = res.status();
  });
  page.on('requestfinished', (r) => done(r, null));
  page.on('requestfailed', (r) => done(r, r.failure()?.errorText || 'failed'));
  page.on('console', (m: ConsoleMessage) => {
    const text = m.text();
    if (!text) return;
    const at = m.location();
    log.addMessage({
      level: level(m.type()),
      text: safeText(text),
      where: at?.url ? `${safeUrl(at.url)}:${at.lineNumber + 1}` : null,
      uncaught: false,
    });
  });
  page.on('pageerror', (err) => {
    // The first frame of the stack says where it was thrown.
    const frame = /\n\s*at .*/.exec(err.stack ?? '')?.[0]?.trim() ?? null;
    log.addMessage({
      level: 'error',
      text: safeText(`${err.name}: ${err.message}`),
      where: frame ? safeText(frame.replace(/^at\s+/, '')) : null,
      uncaught: true,
    });
  });
  return log;
}

/** Requests and console messages shown at most in one reply: the latest ones. */
export const SHOWN_REQUESTS = 60;
export const SHOWN_MESSAGES = 50;

/** Whether a request went wrong: it failed, or the site answered with an error. */
export const requestFailed = (e: NetEntry) => !!e.failure || (e.status !== null && e.status >= 400);

/** One line per request, latest last. */
export function formatRequests(entries: readonly NetEntry[], t: T): string {
  return entries
    .map((e) => {
      const result = e.failure
        ? e.failure === 'net::ERR_BLOCKED_BY_CLIENT'
          ? t('browser.netRefused')
          : t('browser.netFailed', { error: e.failure })
        : e.status !== null
          ? String(e.status)
          : t('browser.netWaiting');
      const time = e.ms !== null ? ` ${e.ms} ms` : '';
      return `#${e.id} ${e.method} ${result} ${e.type}${time} ${e.url}`;
    })
    .join('\n');
}

/** One line per console message, latest last. */
export function formatMessages(entries: readonly ConsoleEntry[], t: T): string {
  return entries
    .map((e) => {
      const kind = e.uncaught ? t('browser.consoleUncaught') : e.level;
      const where = e.where ? ` (${e.where})` : '';
      return `#${e.id} [${kind}] ${e.text}${where}`;
    })
    .join('\n');
}
