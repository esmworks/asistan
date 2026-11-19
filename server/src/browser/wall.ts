import type { Page } from 'playwright-core';

/**
 * What a page put in front of the bot: `checking`, an interstitial that clears by itself after a
 * few seconds ("Just a moment..."); `check`, a challenge a person has to answer (a CAPTCHA, a
 * "press and hold"); `blocked`, a refusal ("Access denied", a bare 403 or 429); or `clear`.
 *
 * A check first gets its own time to pass, then one click on its checkbox — the one gesture a
 * person makes at a Turnstile, with the check still the one that decides. A second click, a reload,
 * a puzzle, a solver service, hiding that the browser is automated: never. Whatever stays after the
 * one click is handed to the person.
 */
export type WallState = 'clear' | 'checking' | 'check' | 'blocked';

export interface PageLook {
  title: string;
  /** The start of the page's visible text. */
  text: string;
  /** Which of `MARKERS` the page holds. */
  markers: string[];
  /** The HTTP status of the page's own response, when known. */
  status?: number | null;
}

/** Elements that only challenge pages carry. */
export const MARKERS = {
  // Cloudflare's interstitial and Turnstile.
  cfRunning: '#challenge-running, #challenge-stage, #cf-challenge-running, .cf-browser-verification',
  turnstile: 'iframe[src*="challenges.cloudflare.com"], .cf-turnstile',
  recaptcha: 'iframe[src*="recaptcha"], .g-recaptcha',
  hcaptcha: 'iframe[src*="hcaptcha.com"], .h-captcha',
  // PerimeterX's and DataDome's challenges.
  pressHold: '#px-captcha, iframe[src*="captcha-delivery.com"]',
} as const;

const CHECKING =
  /just a moment|checking your browser|checking if the site connection is secure|performing security verification|verifying you are human|verifying\.\.\.|ddos-guard|please wait while we verify|bir dakika l(?:ü|u)tfen|taray(?:ı|i)c(?:ı|i)n(?:ı|i)z kontrol ediliyor/i;
const BLOCKED =
  /access denied|you have been blocked|sorry, you have been blocked|unusual traffic|request blocked|forbidden|too many requests|are you a robot|sign in to confirm you(?:'|’)re not a bot|eri(?:ş|s)im engellendi/i;

/** Reads a page's look into a state. */
export function wallState(look: PageLook): WallState {
  const has = (k: keyof typeof MARKERS) => look.markers.includes(k);
  const words = `${look.title}\n${look.text}`;
  // A challenge the page asks a person to answer.
  if (has('recaptcha') || has('hcaptcha') || has('pressHold')) {
    // A sign-up form with a reCAPTCHA at its foot is a page to work with, not a wall: only a page
    // that is little more than the challenge counts.
    if (look.text.length < 1500 || CHECKING.test(words) || BLOCKED.test(words)) return 'check';
  }
  if (has('cfRunning') || (CHECKING.test(look.title) && look.text.length < 1500)) {
    return has('turnstile') ? 'check' : 'checking';
  }
  if (has('turnstile') && look.text.length < 1500) return 'check';
  if ((look.status === 403 || look.status === 429) && look.text.length < 3000) return 'blocked';
  if (BLOCKED.test(look.title) && look.text.length < 1500) return 'blocked';
  return 'clear';
}

const LOOK = (markers: Record<string, string>) => `(() => {
  const m = ${JSON.stringify(markers)};
  const markers = Object.keys(m).filter((k) => { try { return !!document.querySelector(m[k]); } catch { return false; } });
  const text = (document.body && document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 4000);
  return { title: document.title || '', text, markers };
})()`;

/** How the page in front of the bot looks. */
export async function lookAt(page: Page, status?: number | null): Promise<PageLook> {
  const got = (await page.evaluate(LOOK(MARKERS)).catch(() => null)) as Omit<PageLook, 'status'> | null;
  return { ...(got ?? { title: '', text: '', markers: [] }), status };
}

/** Pages whose checkbox the bot already clicked. A repeat reads as a bot and the check escalates,
 * so a page gets one click, not until a read of it comes back clear. */
const CLICKED = new WeakSet<Page>();

/**
 * Where a Turnstile checkbox sits: 28 px in from the frame's left edge, halfway down. Turnstile
 * hangs its frame in a closed shadow root the page script cannot see; the frame list still holds
 * it, and `frameElement` gives its box. A frame with no box, or a box that is not the short and
 * wide checkbox bar, has nothing to click: an image puzzle is a person's step.
 */
async function turnstilePoint(page: Page): Promise<{ x: number; y: number } | null> {
  for (const frame of page.frames()) {
    if (!frame.url().includes('challenges.cloudflare.com')) continue;
    const el = await frame.frameElement().catch(() => null);
    if (!el) continue;
    await el.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => {});
    const box = await el.boundingBox().catch(() => null);
    if (!box || box.width < 100 || box.height < 40 || box.height > 120) continue;
    return { x: box.x + 28, y: box.y + box.height / 2 };
  }
  return null;
}

/** Reads the wall `stepMs` at a time until it stops being a check or `waitMs` passes. */
async function settleCheck(page: Page, waitMs: number, stepMs: number): Promise<WallState> {
  const start = Date.now();
  for (;;) {
    if (page.isClosed() || Date.now() - start >= waitMs) return 'check';
    await page.waitForTimeout(stepMs);
    const state = wallState(await lookAt(page));
    if (state !== 'check') return state;
  }
}

/**
 * A check that stayed: the widget gets a last window to pass by itself — an early click reads as a
 * bot — then one click on its checkbox, then one more wait. That is all the bot ever does to a
 * check; whatever stays after the one click is the person's step.
 */
async function clickThroughCheck(page: Page, opts: { stepMs?: number } = {}): Promise<WallState> {
  const stepMs = opts.stepMs ?? 1_000;
  let state = await settleCheck(page, 3 * stepMs, stepMs);
  if (state === 'clear') return state;
  if (!CLICKED.has(page)) {
    const point = await turnstilePoint(page);
    if (point) {
      CLICKED.add(page);
      await page.mouse.click(point.x, point.y).catch(() => {});
      state = await settleCheck(page, 6 * stepMs, stepMs);
      if (state === 'clear') CLICKED.delete(page);
    }
  }
  return state;
}

/**
 * Waits out an interstitial that clears by itself: up to `waitMs`, reloading once halfway. A check
 * that shows instead goes to `clickThroughCheck`. Returns the state the page ends in; `checking`
 * at the end means it did not clear.
 */
export async function waitOutWall(
  page: Page,
  status?: number | null,
  opts: { waitMs?: number; stepMs?: number } = {},
): Promise<WallState> {
  const waitMs = opts.waitMs ?? 24_000;
  const stepMs = opts.stepMs ?? 1_000;
  let state = wallState(await lookAt(page, status));
  if (state === 'clear') return state;
  if (state === 'check') return await clickThroughCheck(page, opts);
  const start = Date.now();
  let reloaded = false;
  // The status belongs to the first response: once the interstitial has run, the page in front
  // is another one, so only a reload's own status counts after that.
  let current: number | null = null;
  while (Date.now() - start < waitMs) {
    await page.waitForTimeout(stepMs);
    if (!reloaded && Date.now() - start >= waitMs / 2) {
      reloaded = true;
      const res = await page.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => null);
      current = res?.status() ?? null;
    }
    state = wallState(await lookAt(page, current));
    if (state === 'clear') return state;
    if (state === 'check') return await clickThroughCheck(page, opts);
  }
  return state;
}
