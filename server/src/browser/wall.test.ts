import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { waitOutWall, wallState } from './wall';

const look = (o: Partial<Parameters<typeof wallState>[0]>) => ({ title: '', text: '', markers: [], ...o });

/**
 * A fake page: evaluate answers with the scripted looks in order, the last one repeating; a look
 * may also be a function of how many clicks the bot already made.
 */
const fakePage = (
  looks: (
    Partial<Parameters<typeof wallState>[0]> | ((clicks: number) => Partial<Parameters<typeof wallState>[0]>)
  )[],
  frames: unknown[] = [],
) => {
  let read = 0;
  const clicks: [number, number][] = [];
  const lookAt = (i: number) => {
    const l = looks[Math.min(i, looks.length - 1)];
    const o = typeof l === 'function' ? l(clicks.length) : l;
    return o ?? {};
  };
  return {
    clicks,
    url: () => 'https://example.com/',
    isClosed: () => false,
    waitForTimeout: async (ms: number) => void (await new Promise((r) => setTimeout(r, ms))),
    reload: async () => {},
    evaluate: async () => {
      const o = lookAt(read++);
      return { title: o.title ?? '', text: o.text ?? '', markers: o.markers ?? [] };
    },
    mouse: { click: async (x: number, y: number) => void clicks.push([x, y]) },
    frames: () => frames,
  } as unknown as Page & { clicks: [number, number][] };
};

/** A Turnstile frame; without a box it stands for the invisible mode, which no one clicks. */
const turnstileFrame = (box?: { x: number; y: number; width: number; height: number }) => ({
  url: () => 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if.html',
  frameElement: async () =>
    box ? { scrollIntoViewIfNeeded: async () => {}, boundingBox: async () => box } : null,
});

describe('waitOutWall', () => {
  const opts = { waitMs: 1, stepMs: 1 };
  const check = { title: 'Just a moment...', text: 'Verify you are human', markers: ['turnstile'] };
  const clear = { title: 'News', text: 'x'.repeat(300) };

  it('hands a check to the person when there is no turnstile to click', async () => {
    const page = fakePage([check]);
    expect(await waitOutWall(page, null, opts)).toBe('check');
    expect(page.clicks).toEqual([]);
  });

  it('clicks a turnstile checkbox once, then leaves the page to the person', async () => {
    const page = fakePage([check], [turnstileFrame({ x: 100, y: 200, width: 300, height: 65 })]);
    expect(await waitOutWall(page, null, opts)).toBe('check');
    expect(page.clicks).toEqual([[128, 232.5]]);
    expect(await waitOutWall(page, null, opts)).toBe('check');
    expect(page.clicks).toEqual([[128, 232.5]]); // a repeat click reads as a bot: never twice
  });

  it('lets a check that clears by itself pass without a click', async () => {
    const page = fakePage([check, clear]);
    expect(await waitOutWall(page, null, opts)).toBe('clear');
    expect(page.clicks).toEqual([]);
  });

  it('clears after the click and lets the next check in the same tab get its own click', async () => {
    const page = fakePage(
      [(clicks: number) => (clicks > 0 ? clear : check)],
      [turnstileFrame({ x: 0, y: 0, width: 300, height: 65 })],
    );
    expect(await waitOutWall(page, null, opts)).toBe('clear');
    expect(page.clicks).toEqual([[28, 32.5]]);
  });

  it('does not click a puzzle-sized frame or the invisible mode', async () => {
    const puzzle = fakePage([check], [turnstileFrame({ x: 10, y: 10, width: 400, height: 500 })]);
    expect(await waitOutWall(puzzle, null, opts)).toBe('check');
    expect(puzzle.clicks).toEqual([]);

    const invisible = fakePage([check], [turnstileFrame()]);
    expect(await waitOutWall(invisible, null, opts)).toBe('check');
    expect(invisible.clicks).toEqual([]);
  });
});

describe('wallState', () => {
  it('tells a self-clearing interstitial from a challenge a person answers', () => {
    expect(wallState(look({ title: 'Just a moment...', text: 'Checking your browser' }))).toBe('checking');
    expect(wallState(look({ markers: ['cfRunning'], text: 'Performing security verification' }))).toBe(
      'checking',
    );
    expect(wallState(look({ title: 'Just a moment...', markers: ['cfRunning', 'turnstile'] }))).toBe('check');
    expect(wallState(look({ markers: ['recaptcha'], text: 'Verify you are human' }))).toBe('check');
    expect(wallState(look({ markers: ['pressHold'], text: 'Press & Hold' }))).toBe('check');
  });

  it('reads a refusal as blocked', () => {
    expect(wallState(look({ title: 'Access denied', text: 'You do not have access' }))).toBe('blocked');
    expect(wallState(look({ status: 429, text: 'Too many requests' }))).toBe('blocked');
  });

  it('leaves ordinary pages alone, a long form with a reCAPTCHA at its foot too', () => {
    expect(wallState(look({ title: 'News', text: 'Today…' }))).toBe('clear');
    expect(wallState(look({ title: 'Sign up', text: 'x'.repeat(3000), markers: ['recaptcha'] }))).toBe(
      'clear',
    );
    expect(wallState(look({ title: 'Docs: Forbidden errors', text: 'x'.repeat(3000), status: 200 }))).toBe(
      'clear',
    );
  });
});
