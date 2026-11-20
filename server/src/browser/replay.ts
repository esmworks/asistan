import type { ReplayResult, TaughtStep, TaughtTarget } from '@leafbot/shared';
import type { Locator, Page } from 'playwright-core';
import type { z } from 'zod';
import { BrowserError, type BrowserManager, webUrl } from './manager';
import { stepsText } from './teach';
import { browserErrorText } from './text';

type T = (key: string, params?: Record<string, string | number>) => string;
type Target = z.infer<typeof TaughtTarget>;

/** How long a step waits for what it acts on to show; a page that changed shows nothing. */
const FIND_MS = 10_000;
/** How long a step waits for the page it led to before the next step looks for its target. */
const SETTLE_MS = 10_000;

/** Why a step stopped: a sentence for the person or the bot that takes over. */
class StepStop extends Error {}

/**
 * Where a step's target is on the page now, found by what the person saw (a button's words, a
 * field's label) rather than by where it was, so the step still fits a page that moved things.
 */
function locate(page: Page, x: Target): Locator {
  const name = { name: x.label, exact: true };
  const text = page.getByText(x.label, { exact: true });
  switch (x.what) {
    case 'link':
      return page.getByRole('link', name).or(text);
    case 'button':
      return page.getByRole('button', name).or(text);
    case 'checkbox':
      return page
        .getByRole('checkbox', name)
        .or(page.getByRole('radio', name))
        .or(page.getByRole('switch', name))
        .or(page.getByLabel(x.label, { exact: true }));
    case 'menu':
      return page
        .getByRole('combobox', name)
        .or(page.getByRole('listbox', name))
        .or(page.getByLabel(x.label));
    case 'option':
      return page
        .getByRole('option', name)
        .or(page.getByRole('menuitem', name))
        .or(page.getByRole('tab', name))
        .or(text);
    case 'field':
      return page
        .getByLabel(x.label, { exact: true })
        .or(page.getByPlaceholder(x.label, { exact: true }))
        .or(page.getByRole('textbox', name));
    default:
      return text;
  }
}

async function find(page: Page, x: Target, t: T): Promise<Locator> {
  if (!x.label) throw new StepStop(t('replay.noLabel', { what: t(`teach.what.${x.what}`) }));
  const shown = locate(page, x).filter({ visible: true }).first();
  try {
    await shown.waitFor({ state: 'visible', timeout: FIND_MS });
  } catch {
    throw new StepStop(
      t('replay.notFound', {
        target: t('teach.target', { what: t(`teach.what.${x.what}`), label: x.label }),
      }),
    );
  }
  return shown;
}

/** The page settles after a step that may load another; a page that keeps loading does not hold it. */
async function settle(page: Page) {
  await page.waitForLoadState('domcontentloaded', { timeout: SETTLE_MS }).catch(() => {});
}

async function run(page: Page, step: TaughtStep, t: T) {
  switch (step.kind) {
    case 'open':
      await page.goto(webUrl(step.url).toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      return;
    case 'click':
      await (await find(page, step.target, t)).click({ timeout: FIND_MS });
      await settle(page);
      return;
    case 'type':
      // A password is never kept with the steps; the bot enters it from the vault, or the person does.
      if (step.secret) throw new StepStop(t('replay.secret'));
      await (await find(page, step.target, t)).fill(step.text, { timeout: FIND_MS });
      return;
    case 'key':
      await page.keyboard.press(step.key);
      await settle(page);
      return;
    case 'nav':
      if (step.action === 'back') await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30_000 });
      else if (step.action === 'forward')
        await page.goForward({ waitUntil: 'domcontentloaded', timeout: 30_000 });
      else await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
      return;
  }
}

/** A browser's own problem, in the words the bot's browser tools use for it. */
function failure(err: unknown, t: T): string {
  if (err instanceof BrowserError)
    return browserErrorText(err, t as unknown as Parameters<typeof browserErrorText>[1]);
  // Playwright's messages carry a call log after the first line; the first line says what went wrong.
  return t('replay.failed', { message: (err instanceof Error ? err.message : String(err)).split('\n')[0]! });
}

/**
 * Does a taught task again in the bot's browser, step by step and without the model, so a task a
 * person showed once costs nothing to repeat. It stops at the first step that no longer fits the
 * page (or that needs a password) and says which, so the bot or the person can finish from there.
 * Each step goes through the browser's queue, so it does not cross the bot's own browser calls,
 * and stops when the person takes control.
 */
export async function replaySteps(
  browser: BrowserManager,
  botId: string,
  steps: TaughtStep[],
  t: T,
): Promise<ReplayResult> {
  const total = steps.length;
  for (const [i, step] of steps.entries()) {
    try {
      await browser.use(botId, (page) => run(page, step, t));
    } catch (err) {
      const reason = err instanceof StepStop ? err.message : failure(err, t);
      return { ok: false, done: i, total, failedAt: { step: i + 1, reason } };
    }
  }
  return { ok: true, done: total, total };
}

/** A stopped replay for the bot that finishes it: where it stopped, why, and the steps left. */
export function replayHandOver(result: ReplayResult, steps: TaughtStep[], t: T): string {
  if (result.ok) return t('replay.done', { total: result.total });
  const at = result.failedAt!;
  return [
    t('replay.stopped', { step: at.step, total: result.total, reason: at.reason }),
    '',
    stepsText(steps.slice(at.step - 1), t),
  ].join('\n');
}
