import { spawn, type ChildProcess } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { mkdirSync } from 'node:fs';
import { isIP } from 'node:net';
import type { BrowserInput, BrowserState } from '@yumakbot/shared';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright-core';
import { privateAddress } from '../services/skill-link';

/** The size of every bot's browser window, in CSS pixels. */
export const VIEWPORT = { width: 1280, height: 800 };
/**
 * The screen the page is told it is on: a common one for the computer the server runs on, larger
 * than the window as a real screen is. A headless browser otherwise reports a screen exactly the
 * size of its page, with one pixel per point even on a Mac, which sites read as a robot.
 */
export const SCREEN =
  process.platform === 'darwin'
    ? { width: 1512, height: 982, scale: 2 }
    : { width: 1920, height: 1080, scale: 1 };

const SHORTCUT_MODIFIERS = new Set(['Control', 'Meta', 'Alt']);

export type BrowserErrorCode = 'unavailable' | 'userControl' | 'full' | 'launch' | 'badUrl' | 'busy' | 'hung';

export class BrowserError extends Error {
  constructor(
    readonly code: BrowserErrorCode,
    detail = '',
  ) {
    super(detail || code);
  }
}

/**
 * A headless Chrome names itself "HeadlessChrome" in every request, which sign-in pages read as a
 * robot; the same browser with a window says "Chrome". Null when there is nothing to change.
 */
export function windowedUserAgent(userAgent: string): string | null {
  return userAgent.includes('HeadlessChrome/') ? userAgent.replaceAll('HeadlessChrome/', 'Chrome/') : null;
}

/** Only web addresses: no file://, chrome:// or javascript: (the browser runs next to the server's data). */
export function webUrl(raw: string): URL {
  const text = raw.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
  } catch {
    throw new BrowserError('badUrl', text);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BrowserError('badUrl', text);
  return url;
}

export interface Frame {
  data: Buffer;
  width: number;
  height: number;
}

interface Live {
  botId: string;
  /** Set when connected to a browser that runs elsewhere (the bot's desktop); closing disconnects. */
  remote: Browser | null;
  context: BrowserContext;
  page: Page;
  title: string | null;
  cast: CDPSession | null;
  lastFrame: Frame | null;
  /** Bot actions running now. */
  busy: number;
  /** A person took control; the bot's actions are refused until they hand it back. */
  userControl: boolean;
  /** Control, Meta and Alt keys the person is holding down. */
  modifiers: Set<string>;
  /** The person's input, applied one event at a time. */
  inputs: Promise<void>;
  /** Passwords typed into this browser from the vault; hidden from everything the bot reads. */
  secrets: Set<string>;
  lastUsed: number;
  /** Bot actions run one after another, even from two threads of the same bot. */
  queue: Promise<unknown>;
  /** The page's own questions (alert, confirm, prompt) since the bot last heard of them. */
  dialogs: PageDialog[];
  /** How to answer the page's next confirm or prompt, as the bot chose; once. */
  nextAnswer: { accept: boolean; text?: string } | null;
  /** Hosts on this computer or a private network the page tried to reach, since the bot last heard. */
  refused: Set<string>;
}

/** A question a page asked with alert, confirm or prompt, and how it was answered. */
export interface PageDialog {
  type: string;
  message: string;
  accepted: boolean;
}

export interface BrowserListener {
  state(s: BrowserState): void;
  frame(botId: string, f: Frame): void;
}

export interface BrowserManagerOptions {
  executable: string | null;
  /** The bot's own profile folder: its logins and cookies stay between runs. */
  profileDir(botId: string): string;
  sandbox: boolean;
  max: number;
  idleMs: number;
  /**
   * The longest one bot step may take. A page whose main thread hangs never answers, and every
   * later step of that bot would wait behind it; past this the browser starts afresh instead.
   */
  callMs?: number;
  /**
   * Hosts on this computer or a private network the bots' browsers may still reach (a router's
   * page, a service on the LAN). Every other private, loopback or link-local address is refused.
   */
  localHosts?: string[];
  headless?: boolean;
  /**
   * Use the Chromium on the bot's desktop instead of starting one here: returns its DevTools
   * WebSocket address, starting the desktop if needed.
   */
  connect?: (botId: string) => Promise<string>;
  /** True while a person has control of the bot's desktop; the bot's browser steps then wait. */
  blocked?: (botId: string) => boolean;
  /** Keeps the bot's desktop awake during a browser step; returns the release. */
  hold?: (botId: string) => () => void;
  /**
   * The server runs on the person's own computer, so the bot's browser can also open there as an
   * ordinary window for them to sign in by hand.
   */
  windows?: boolean;
  /** Starts a program; tests pass a stand-in so no window opens. */
  spawn?: (command: string, args: string[]) => ChildProcess;
}

/** A window of the bot's browser that a person uses directly; the bot waits until it closes. */
interface Window {
  child: ChildProcess;
  exited: Promise<void>;
}

/**
 * One browser per bot, started on first use. The bot drives it with tools; people can watch its
 * screen live and take control (for a login or a captcha), during which the bot waits.
 */
export class BrowserManager {
  private live = new Map<string, Live>();
  private starting = new Map<string, Promise<Live>>();
  private watchers = new Map<string, Set<string>>();
  private hosts = new Map<string, { ok: boolean; at: number }>();
  private listeners = new Set<BrowserListener>();
  private sweep: NodeJS.Timeout | null = null;
  private closed = false;
  private userAgent: Promise<string | undefined> | null = null;
  private windows = new Map<string, Window>();

  constructor(private opts: BrowserManagerOptions) {}

  get available() {
    return !!this.opts.executable || !!this.opts.connect;
  }

  get executable() {
    return this.opts.executable;
  }

  /** Whether a person can open the bot's browser as a window of its own on this computer. */
  get windowAvailable() {
    return !!this.opts.windows && !!this.opts.executable && !this.opts.connect;
  }

  on(l: BrowserListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  state(botId: string): BrowserState {
    if (this.windows.has(botId)) return { botId, status: 'window', url: null, title: null, tabs: 0 };
    const l = this.live.get(botId);
    if (!l) return { botId, status: 'off', url: null, title: null, tabs: 0 };
    const url = l.page.url();
    return {
      botId,
      status: l.userControl ? 'user' : l.busy > 0 ? 'bot' : 'idle',
      url: url && url !== 'about:blank' ? url : null,
      title: l.title || null,
      tabs: l.context.pages().length,
    };
  }

  private get callMs() {
    return this.opts.callMs ?? 90_000;
  }

  /** Runs a bot action on its active page, starting the browser if needed. */
  async use<T>(botId: string, fn: (page: Page) => Promise<T>): Promise<T> {
    const live = await this.get(botId);
    const run = async () => {
      if (live.userControl || this.windows.has(botId) || this.opts.blocked?.(botId)) {
        throw new BrowserError('userControl');
      }
      live.busy++;
      this.emitState(live);
      const release = this.opts.hold?.(botId);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const step = fn(live.page);
      try {
        return await Promise.race([
          step,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              // Closing the browser also ends the call still waiting on it.
              step.catch(() => {});
              if (this.live.get(botId) === live) void this.close(botId);
              reject(new BrowserError('hung', String(Math.round(this.callMs / 1000))));
            }, this.callMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        release?.();
        live.busy--;
        live.lastUsed = Date.now();
        this.emitState(live);
      }
    };
    const result = live.queue.then(run, run);
    live.queue = result.catch(() => {});
    return result;
  }

  /**
   * Refuses every request of the browser to this computer or a private network: a page, a link it
   * follows, a redirect or a script on it could otherwise reach the server's own API, other local
   * services, the LAN or a cloud's metadata address with the server's network position.
   */
  private async guardNetwork(live: Live, context: BrowserContext) {
    await context.route('**/*', async (route) => {
      let host = '';
      try {
        host = new URL(route.request().url()).hostname;
      } catch {
        return route.continue();
      }
      if (await this.reachable(host)) return route.continue();
      live.refused.add(host.replace(/^\[|\]$/g, ''));
      return route.abort('blockedbyclient');
    });
  }

  /** Whether a host is public (or allowed); answers are kept a minute. */
  private async reachable(raw: string): Promise<boolean> {
    const host = raw.replace(/^\[|\]$/g, '').toLowerCase();
    if (!host || this.opts.localHosts?.includes(host)) return true;
    const known = this.hosts.get(host);
    if (known && Date.now() - known.at < 60_000) return known.ok;
    let ok: boolean;
    if (isIP(host)) ok = !privateAddress(host);
    else if (host === 'localhost' || host.endsWith('.localhost')) ok = false;
    else {
      // A name that does not resolve fails in the browser anyway.
      const addresses = await lookup(host, { all: true }).catch(() => []);
      ok = !addresses.some((a) => privateAddress(a.address));
    }
    this.hosts.set(host, { ok, at: Date.now() });
    return ok;
  }

  /** The private hosts the page tried to reach since the bot last heard of them; heard once. */
  takeRefused(botId: string): string[] {
    const l = this.live.get(botId);
    if (!l) return [];
    const out = [...l.refused];
    l.refused.clear();
    return out;
  }

  /** The page's questions since the bot last heard of them; heard once. */
  takeDialogs(botId: string): PageDialog[] {
    const l = this.live.get(botId);
    if (!l) return [];
    const out = l.dialogs;
    l.dialogs = [];
    return out;
  }

  /** How the bot wants the page's next confirm or prompt answered. */
  answerNextDialog(botId: string, answer: { accept: boolean; text?: string }) {
    const l = this.live.get(botId);
    if (l) l.nextAnswer = answer;
  }

  /** The bot's open tabs, the active one marked. */
  pages(botId: string): { pages: Page[]; active: Page } | null {
    const l = this.live.get(botId);
    return l ? { pages: l.context.pages(), active: l.page } : null;
  }

  /** Remember a password typed into this bot's browser, so tool output never shows it. */
  rememberSecret(botId: string, secret: string) {
    this.live.get(botId)?.secrets.add(secret);
  }

  secrets(botId: string): string[] {
    return [...(this.live.get(botId)?.secrets ?? [])];
  }

  async newPage(botId: string): Promise<Page> {
    const l = await this.get(botId);
    const page = await l.context.newPage();
    this.activate(l, page);
    return page;
  }

  select(botId: string, page: Page) {
    const l = this.live.get(botId);
    if (l && l.context.pages().includes(page)) this.activate(l, page);
  }

  watch(botId: string, watcherId: string): { state: BrowserState; frame: Frame | null } {
    let set = this.watchers.get(botId);
    if (!set) this.watchers.set(botId, (set = new Set()));
    set.add(watcherId);
    const l = this.live.get(botId);
    if (l) l.lastUsed = Date.now();
    if (l && !l.cast) void this.startCast(l);
    return { state: this.state(botId), frame: l?.lastFrame ?? null };
  }

  unwatch(botId: string, watcherId: string) {
    const set = this.watchers.get(botId);
    if (!set?.delete(watcherId) || set.size) return;
    this.watchers.delete(botId);
    const l = this.live.get(botId);
    if (!l) return;
    void this.stopCast(l);
    // Nobody is looking any more: control goes back to the bot.
    this.release(l);
  }

  /** Take control (starting the browser if it is off) or hand it back to the bot. */
  async setControl(botId: string, on: boolean) {
    if (!on) {
      const l = this.live.get(botId);
      if (l) this.release(l);
      return;
    }
    const l = await this.get(botId);
    l.userControl = true;
    this.emitState(l);
  }

  private release(l: Live) {
    if (!l.userControl) return;
    l.userControl = false;
    l.lastUsed = Date.now();
    // Keys still held by the person would otherwise stay down for the bot.
    for (const key of l.modifiers) void l.page.keyboard.up(key).catch(() => {});
    l.modifiers.clear();
    this.emitState(l);
  }

  /** A person's mouse, keyboard or address bar input; ignored unless they have control. */
  input(botId: string, input: BrowserInput): Promise<void> {
    const l = this.live.get(botId);
    if (!l?.userControl) return Promise.resolve();
    // In arrival order: a click must land before the keys typed after it.
    l.inputs = l.inputs.then(() => this.apply(l, input)).catch(() => {});
    return l.inputs;
  }

  private async apply(l: Live, input: BrowserInput) {
    if (!l.userControl) return;
    l.lastUsed = Date.now();
    const page = l.page;
    const at = (x: number, y: number) =>
      [Math.round(x * VIEWPORT.width), Math.round(y * VIEWPORT.height)] as const;
    try {
      switch (input.type) {
        case 'mouse': {
          const [x, y] = at(input.x, input.y);
          await page.mouse.move(x, y);
          if (input.action === 'down') await page.mouse.down({ button: input.button });
          if (input.action === 'up') await page.mouse.up({ button: input.button });
          break;
        }
        case 'wheel': {
          const [x, y] = at(input.x, input.y);
          await page.mouse.move(x, y);
          await page.mouse.wheel(input.dx, input.dy);
          break;
        }
        case 'key': {
          const { key, action } = input;
          if (SHORTCUT_MODIFIERS.has(key)) {
            if (action === 'down') l.modifiers.add(key);
            else l.modifiers.delete(key);
          }
          if ([...key].length === 1) {
            if (action !== 'down') break;
            // With Control, Meta or Alt held it is a shortcut (Ctrl+A); otherwise it is typed as
            // text, so any keyboard layout (ş, ğ, ü) works.
            if (l.modifiers.size) await page.keyboard.press(key);
            else await page.keyboard.insertText(key);
          } else if (action === 'down') await page.keyboard.down(key);
          else await page.keyboard.up(key);
          break;
        }
        case 'text':
          await page.keyboard.insertText(input.text);
          break;
        case 'nav':
          if (input.action === 'back') await page.goBack({ timeout: 15_000 });
          else if (input.action === 'forward') await page.goForward({ timeout: 15_000 });
          else await page.reload({ timeout: 15_000 });
          break;
        case 'open':
          await page.goto(webUrl(input.url).toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
          break;
      }
    } catch {
      // A key the browser does not know or a page that would not load: nothing to report back.
    }
  }

  async close(botId: string) {
    const l = this.live.get(botId);
    if (!l) return;
    this.live.delete(botId);
    await this.stopCast(l);
    if (l.remote) await l.remote.close().catch(() => {});
    else await l.context.close().catch(() => {});
    this.emitState(l);
  }

  /**
   * Opens the bot's browser as an ordinary window, with its own profile and not driven by this
   * server, so the person can sign in to sites that refuse a remote-controlled browser. The cookies
   * stay in the profile; the bot's browser starts again with them once the window is closed.
   */
  async openWindow(botId: string, url?: string) {
    if (this.closed || !this.windowAvailable) throw new BrowserError('unavailable');
    if (this.windows.has(botId)) return;
    const address = url ? webUrl(url).toString() : null;
    await this.starting.get(botId)?.catch(() => {});
    const l = this.live.get(botId);
    if (l?.busy) throw new BrowserError('busy');
    if (this.windows.has(botId)) return;
    // Marked first: from here the bot's steps are refused and its browser cannot start again.
    let done!: () => void;
    const window: Window = { child: null!, exited: new Promise<void>((r) => (done = r)) };
    this.windows.set(botId, window);
    this.emitBot(botId);
    // Two programs cannot share a profile: the bot's browser closes first.
    await this.close(botId);
    const args = [
      `--user-data-dir=${this.opts.profileDir(botId)}`,
      // The bot's browser keeps its cookies under these settings; the window must read the same.
      '--password-store=basic',
      '--use-mock-keychain',
      '--disable-sync',
      '--no-first-run',
      '--no-default-browser-check',
      ...(address ? [address] : []),
    ];
    let child: ChildProcess;
    try {
      child = (this.opts.spawn ?? defaultSpawn)(this.opts.executable!, args);
    } catch (err) {
      this.windows.delete(botId);
      done();
      this.emitBot(botId);
      throw new BrowserError('launch', (err as Error).message.split('\n')[0]);
    }
    window.child = child;
    const end = () => {
      if (this.windows.get(botId) !== window) return;
      this.windows.delete(botId);
      done();
      this.emitBot(botId);
    };
    child.once('exit', end);
    child.once('error', end);
  }

  /**
   * Closes the window. On a Mac the browser keeps running after its last window closes, so this
   * asks it to quit. Chrome saves new cookies to disk only every 30 seconds: on SIGINT it quits as
   * from its menu and saves them first, while SIGTERM quits at once and loses them. Windows has no
   * such signal, so there the cookies are given time to be saved before the program is stopped.
   */
  async closeWindow(botId: string) {
    const w = this.windows.get(botId);
    // Still closing the bot's own browser: the program has not started yet.
    if (!w?.child) return;
    if (process.platform === 'win32') {
      const ended = await Promise.race([w.exited.then(() => true), sleep(COOKIE_SAVE_MS).then(() => false)]);
      if (ended) return;
    }
    w.child.kill(process.platform === 'win32' ? 'SIGTERM' : 'SIGINT');
    const timer = setTimeout(() => w.child.kill('SIGKILL'), 15_000);
    await w.exited;
    clearTimeout(timer);
  }

  async shutdown() {
    this.closed = true;
    if (this.sweep) clearInterval(this.sweep);
    await Promise.allSettled([...this.starting.values()]);
    await Promise.allSettled([
      ...[...this.live.keys()].map((id) => this.close(id)),
      ...[...this.windows.keys()].map((id) => this.closeWindow(id)),
    ]);
  }

  private async get(botId: string): Promise<Live> {
    const l = this.live.get(botId);
    if (l) return l;
    let p = this.starting.get(botId);
    if (!p) {
      p = this.launch(botId).finally(() => this.starting.delete(botId));
      this.starting.set(botId, p);
    }
    return p;
  }

  private async launch(botId: string): Promise<Live> {
    if (this.closed || !this.available) throw new BrowserError('unavailable');
    if (this.windows.has(botId)) throw new BrowserError('userControl');
    await this.makeRoom();
    let context: BrowserContext;
    let remote: Browser | null = null;
    if (this.opts.connect) {
      try {
        remote = await chromium.connectOverCDP(await this.opts.connect(botId), { timeout: 30_000 });
      } catch (err) {
        throw new BrowserError('launch', (err as Error).message.split('\n')[0]);
      }
      // The desktop's browser has one default context: its profile, tabs and windows.
      context = remote.contexts()[0] ?? (await remote.newContext());
      return this.adopt(botId, context, remote);
    }
    const dir = this.opts.profileDir(botId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const headless = this.opts.headless ?? true;
    const userAgent = headless ? await this.windowedUserAgent() : undefined;
    try {
      context = await chromium.launchPersistentContext(dir, {
        executablePath: this.opts.executable ?? undefined,
        headless,
        ...(userAgent ? { userAgent } : {}),
        chromiumSandbox: this.opts.sandbox,
        viewport: VIEWPORT,
        screen: { width: SCREEN.width, height: SCREEN.height },
        deviceScaleFactor: SCREEN.scale,
        acceptDownloads: false,
        // Sites such as Google refuse to sign in a browser that says it is driven by a program: no
        // "controlled by automated software" mark, and navigator.webdriver stays false.
        ignoreDefaultArgs: ['--enable-automation'],
        args: [
          '--disable-dev-shm-usage',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-blink-features=AutomationControlled',
          // A page the bot opens never plays sound on the computer the server runs on.
          '--mute-audio',
        ],
        timeout: 30_000,
      });
    } catch (err) {
      throw new BrowserError('launch', (err as Error).message.split('\n')[0]);
    }
    return this.adopt(botId, context, null);
  }

  /**
   * The identity this browser gives with a window, learned once from a short headless start with
   * no profile. Undefined when it cannot be learned: the browser then keeps its own.
   */
  private windowedUserAgent(): Promise<string | undefined> {
    this.userAgent ??= (async () => {
      const browser = await chromium.launch({
        executablePath: this.opts.executable ?? undefined,
        headless: true,
        chromiumSandbox: this.opts.sandbox,
        args: ['--disable-dev-shm-usage'],
        timeout: 30_000,
      });
      try {
        const page = await browser.newPage();
        return windowedUserAgent(await page.evaluate(() => navigator.userAgent)) ?? undefined;
      } finally {
        await browser.close();
      }
    })().catch(() => undefined);
    return this.userAgent;
  }

  private async adopt(botId: string, context: BrowserContext, remote: Browser | null): Promise<Live> {
    context.setDefaultTimeout(15_000);
    // On a desktop the last tab is the one most likely in front.
    const page = context.pages().at(-1) ?? (await context.newPage());
    const live: Live = {
      botId,
      remote,
      context,
      page,
      title: null,
      cast: null,
      lastFrame: null,
      busy: 0,
      userControl: false,
      modifiers: new Set(),
      inputs: Promise.resolve(),
      secrets: new Set(),
      lastUsed: Date.now(),
      queue: Promise.resolve(),
      dialogs: [],
      nextAnswer: null,
      refused: new Set(),
    };
    await this.guardNetwork(live, context);
    for (const p of context.pages()) this.track(live, p);
    context.on('page', (p) => {
      this.track(live, p);
      // Links that open a new tab: follow them, as a person would.
      this.activate(live, p);
    });
    const gone = () => {
      if (this.live.get(botId) !== live) return;
      this.live.delete(botId);
      live.cast = null;
      this.emitState(live);
    };
    context.on('close', gone);
    // The person may close the desktop's browser, or the desktop may go to sleep.
    remote?.on('disconnected', gone);
    this.live.set(botId, live);
    this.startSweep();
    if (this.watchers.has(botId)) void this.startCast(live);
    this.emitState(live);
    return live;
  }

  private track(live: Live, page: Page) {
    // Without a listener a page's confirm is cancelled unseen, and the click that asked it does
    // nothing the bot can tell. A notice is let through; a confirm or prompt is answered as the bot
    // said beforehand, else cancelled, and either way the bot hears what the page asked.
    page.on('dialog', (dialog) => {
      const type = dialog.type();
      const answer = type === 'confirm' || type === 'prompt' ? live.nextAnswer : { accept: true };
      if (type === 'confirm' || type === 'prompt') live.nextAnswer = null;
      const accepted = !!answer?.accept;
      live.dialogs.push({ type, message: dialog.message().slice(0, 500), accepted });
      if (live.dialogs.length > 5) live.dialogs.shift();
      void (accepted ? dialog.accept(answer?.text) : dialog.dismiss()).catch(() => {});
    });
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame() || live.page !== page) return;
      this.emitState(live);
    });
    page.on('load', () => {
      if (live.page !== page) return;
      void page
        .title()
        .then((title) => {
          live.title = title;
          this.emitState(live);
        })
        .catch(() => {});
    });
    // A tab whose page crashed (out of memory, say) cannot be used again: the same address
    // opens in a fresh tab and the dead one closes, so the bot's next step finds a page.
    page.on('crash', () => {
      const url = page.url();
      console.warn(`browser page crashed: ${url}`);
      void (async () => {
        const fresh = await live.context.newPage();
        if (/^https?:/i.test(url)) await fresh.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
        this.activate(live, fresh);
        await page.close().catch(() => {});
      })().catch(() => {});
    });
    page.on('close', () => {
      if (live.page !== page || !this.live.has(live.botId)) return;
      const rest = live.context.pages().filter((p) => p !== page);
      if (rest.length) this.activate(live, rest.at(-1)!);
      else void live.context.newPage().catch(() => {});
    });
  }

  private activate(live: Live, page: Page) {
    if (live.page === page) return;
    live.page = page;
    live.title = null;
    void page
      .title()
      .then((title) => {
        live.title = title;
        this.emitState(live);
      })
      .catch(() => {});
    if (this.watchers.has(live.botId)) void this.startCast(live);
    this.emitState(live);
  }

  private async startCast(live: Live) {
    await this.stopCast(live);
    const page = live.page;
    let cdp: CDPSession;
    try {
      cdp = await live.context.newCDPSession(page);
    } catch {
      return;
    }
    live.cast = cdp;
    cdp.on('Page.screencastFrame', (f) => {
      void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
      if (live.cast !== cdp) return;
      const frame = {
        data: Buffer.from(f.data, 'base64'),
        width: Math.round(f.metadata.deviceWidth),
        height: Math.round(f.metadata.deviceHeight),
      };
      live.lastFrame = frame;
      for (const l of this.listeners) l.frame(live.botId, frame);
    });
    await cdp
      .send('Page.startScreencast', {
        format: 'jpeg',
        quality: 60,
        maxWidth: VIEWPORT.width,
        maxHeight: VIEWPORT.height,
      })
      .catch(() => {});
  }

  private async stopCast(live: Live) {
    const cdp = live.cast;
    live.cast = null;
    if (!cdp) return;
    await cdp.send('Page.stopScreencast').catch(() => {});
    await cdp.detach().catch(() => {});
  }

  /** At the limit, the least recently used browser nobody is using or watching is closed. */
  private async makeRoom() {
    if (this.live.size < this.opts.max) return;
    const idle = [...this.live.values()]
      // Someone watching does not keep it: a view left open would hold the browser for good.
      .filter((l) => !l.busy && !l.userControl)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    if (!idle[0]) throw new BrowserError('full');
    await this.close(idle[0].botId);
  }

  private startSweep() {
    if (this.sweep) return;
    this.sweep = setInterval(() => {
      const now = Date.now();
      for (const l of this.live.values()) {
        // A view left open does not keep an idle browser; a person holding control does.
        if (l.busy || l.userControl) continue;
        if (now - l.lastUsed > this.opts.idleMs) void this.close(l.botId);
      }
    }, 60_000);
    this.sweep.unref();
  }

  private emitState(live: Live) {
    this.emitBot(live.botId);
  }

  private emitBot(botId: string) {
    const s = this.state(botId);
    for (const l of this.listeners) l.state(s);
  }
}

/** A little longer than the interval at which Chrome saves new cookies to disk. */
const COOKIE_SAVE_MS = 32_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function defaultSpawn(command: string, args: string[]): ChildProcess {
  return spawn(command, args, { stdio: 'ignore' });
}
