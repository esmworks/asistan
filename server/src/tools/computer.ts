import { DESKTOP_SIZE, type Bot, type DesktopAction } from '@yumakbot/shared';
import { z } from 'zod';
import { ComputerError, type ComputerClient } from '../computer/client';
import type { ComputerService } from '../computer/service';
import type { AppTool, ToolResult } from '../engine/types';
import type { T } from '../i18n';
import type { Define } from './index';

const x = z
  .number()
  .int()
  .min(0)
  .max(DESKTOP_SIZE.width - 1);
const y = z
  .number()
  .int()
  .min(0)
  .max(DESKTOP_SIZE.height - 1);
const sends = z
  .boolean()
  .default(false)
  .describe('true if this sends, posts, buys, books, deletes or shares something');

/** Lets the screen redraw after an action before the bot looks at it again. */
const SETTLE_MS = 600;
/** The longest a background command keeps the desktop awake. */
const BACKGROUND_MAX_MS = 2 * 60 * 60_000;

export function computerErrorText(err: unknown, t: T): string {
  if (err instanceof ComputerError) {
    if (err.code === 'userControl') return t('computer.userControl');
    if (err.code === 'full') return t('computer.full');
    if (err.code === 'unreachable') return t('computer.unreachable');
    return t('computer.failed', { message: err.message });
  }
  return t('computer.failed', { message: (err as Error).message });
}

/**
 * The bot's own desktop: look at the screen, use the mouse and keyboard, and run commands in its
 * terminal. Looking and moving around run without a card; a step marked as sending something, and
 * every command, follow the bot's permission settings. A read-only bot can only look.
 */
export function computerTools(opts: {
  def: Define;
  bot: Bot;
  t: T;
  computer: ComputerService;
  /** Where commands run: the thread's work folder. */
  cwd: string;
}): AppTool[] {
  const { def, bot, t, computer, cwd } = opts;
  const readOnly = bot.permissionMode === 'readonly';

  const guard = async (fn: (c: ComputerClient) => Promise<ToolResult>): Promise<ToolResult> => {
    try {
      return await computer.use(bot.id, fn);
    } catch (err) {
      return computerErrorText(err, t);
    }
  };

  const look = async (c: ComputerClient): Promise<ToolResult> => {
    const shot = await c.screenshot(bot.id);
    return {
      text: t('computer.screen', { width: shot.width, height: shot.height }),
      images: [{ data: shot.png, mimeType: 'image/png' }],
    };
  };

  const act = (action: DesktopAction) =>
    guard(async (c) => {
      await c.action(bot.id, action);
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      return look(c);
    });

  // Read-only bots may look but not touch: these then go through the normal permission check.
  const touch = async (a: object) => readOnly || ('sends' in a && a.sends === true);

  return [
    def('computer_screenshot', {}, async () => guard(look), 'internal'),
    def(
      'computer_click',
      {
        x,
        y,
        button: z.enum(['left', 'right', 'middle']).default('left'),
        count: z.number().int().min(1).max(3).default(1),
        sends,
      },
      async (a) => act({ type: 'click', x: a.x, y: a.y, button: a.button, count: a.count }),
      'internal',
      touch,
    ),
    def(
      'computer_type',
      { text: z.string().min(1).max(5000), sends },
      async (a) => act({ type: 'type', text: a.text }),
      'internal',
      touch,
    ),
    def(
      'computer_key',
      {
        keys: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[A-Za-z0-9_+ -]+$/)
          .describe('xdotool key names joined by +, e.g. Return, ctrl+s, alt+Tab'),
        sends,
      },
      async (a) => act({ type: 'key', keys: a.keys }),
      'internal',
      touch,
    ),
    def(
      'computer_scroll',
      {
        x,
        y,
        direction: z.enum(['up', 'down', 'left', 'right']),
        amount: z.number().int().min(1).max(30).default(3),
      },
      async (a) => act({ type: 'scroll', x: a.x, y: a.y, direction: a.direction, amount: a.amount }),
      'internal',
      touch,
    ),
    def(
      'computer_drag',
      { from_x: x, from_y: y, to_x: x, to_y: y },
      async (a) => act({ type: 'drag', from: { x: a.from_x, y: a.from_y }, to: { x: a.to_x, y: a.to_y } }),
      'internal',
      touch,
    ),
    def(
      'run_command',
      {
        command: z.string().min(1).max(100_000),
        timeout_seconds: z.number().int().min(1).max(600).default(120),
        background: z
          .boolean()
          .default(false)
          .describe('Leave it running (a build, an install) and check it with command_status'),
      },
      async (a) =>
        guard(async (c) => {
          if (a.background) {
            const job = await c.startJob(bot.id, { command: a.command, cwd });
            computer.keepAwake(bot.id, BACKGROUND_MAX_MS);
            return t('computer.jobStarted', { id: job.id });
          }
          const r = await c.exec(bot.id, { command: a.command, cwd, timeoutMs: a.timeout_seconds * 1000 });
          const notes = [
            r.timedOut ? t('computer.timedOut', { seconds: a.timeout_seconds }) : null,
            r.truncated ? t('computer.truncated') : null,
          ].filter(Boolean);
          return [
            t('computer.exitCode', { code: r.exitCode ?? '-' }),
            ...notes,
            r.output || t('computer.noOutput'),
          ].join('\n');
        }),
    ),
    def(
      'command_status',
      {
        id: z.string().regex(/^[\w-]{1,40}$/),
        wait_seconds: z.number().int().min(0).max(60).default(0),
      },
      async (a) =>
        guard(async (c) => {
          const job = await c.job(bot.id, { id: a.id, waitMs: a.wait_seconds * 1000 });
          if (!job.running) computer.keepAwake(bot.id, 0);
          return [
            job.running
              ? t('computer.jobRunning', { seconds: job.seconds })
              : t('computer.exitCode', { code: job.exitCode ?? '-' }),
            ...(job.truncated ? [t('computer.truncated')] : []),
            job.output || t('computer.noOutput'),
          ].join('\n');
        }),
      'internal',
    ),
  ];
}
