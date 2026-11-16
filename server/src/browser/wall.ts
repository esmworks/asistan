import type { Page } from 'playwright-core';

/**
 * What a page put in front of the bot: `checking`, an interstitial that clears by itself after a
 * few seconds ("Just a moment..."); `check`, a challenge a person has to answer (a CAPTCHA, a
 * "press and hold"); `blocked`, a refusal ("Access denied", a bare 403 or 429); or `clear`.
 *
 * The bot is never to get past a check itself: no clicking the box to pass as a person, no solving
 * services, no hiding that the browser is automated. All the server does is wait, reload once and
 * then hand the step to the person.
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

/**
 * Waits out an interstitial that clears by itself: up to `waitMs`, reloading once halfway. Returns
 * the state the page ends in; `checking` at the end means it did not clear.
 */
export async function waitOutWall(
  page: Page,
  status?: number | null,
  opts: { waitMs?: number; stepMs?: number } = {},
): Promise<WallState> {
  const waitMs = opts.waitMs ?? 24_000;
  const stepMs = opts.stepMs ?? 1_000;
  let state = wallState(await lookAt(page, status));
  if (state === 'clear' || state === 'check') return state;
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
    if (state === 'clear' || state === 'check') return state;
  }
  return state;
}
