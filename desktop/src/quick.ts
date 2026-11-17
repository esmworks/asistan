import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The quick window: a small window, opened from anywhere with a global shortcut, that lists what
 * the bots wait on the person for and lets them answer from the keyboard without switching to the
 * app. These are the parts that need no Electron, so they can be tested.
 */

/**
 * Shortcuts tried in order; the first one no other app holds is used. Neither is one the system
 * keeps for itself: Alt+Space opens every window's menu on Windows and types a no-break space on
 * a Mac, so taking it would break that in every app.
 */
export const QUICK_KEYS = ['CommandOrControl+Shift+Space', 'CommandOrControl+Alt+Shift+Space'] as const;

/** Registers the first shortcut `register` accepts and returns it, or null when all are taken. */
export function claimQuickKey(register: (accelerator: string) => boolean): string | null {
  for (const key of QUICK_KEYS) {
    try {
      if (register(key)) return key;
    } catch {
      // A shortcut the system does not know counts as taken.
    }
  }
  return null;
}

export const QUICK_SIZE = { width: 460, height: 520 };

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where the window opens: centred across the screen the pointer is on, a fifth of the way down,
 * like a launcher, and never past its edges.
 */
export function quickBounds(workArea: Rect, size = QUICK_SIZE): Rect {
  const width = Math.min(size.width, workArea.width);
  const height = Math.min(size.height, workArea.height);
  const x = workArea.x + Math.round((workArea.width - width) / 2);
  const y = workArea.y + Math.min(Math.round(workArea.height / 5), workArea.height - height);
  return { x, y, width, height };
}

/** The page URL of the quick window on the server at `origin`. */
export function quickUrl(origin: string): string {
  const url = new URL(origin);
  url.searchParams.set('quick', '1');
  return url.toString();
}

/** A conversation id the page may ask to open; anything else is refused. */
export const isThreadId = (v: unknown): v is string => typeof v === 'string' && /^[\w-]{1,64}$/.test(v);

const SETTING_FILE = 'quick.json';

/** Whether the person keeps the global shortcut on; on until they turn it off. */
export function readQuickOn(dir: string): boolean {
  try {
    return (JSON.parse(readFileSync(join(dir, SETTING_FILE), 'utf8')) as { on?: unknown }).on !== false;
  } catch {
    return true;
  }
}

export function writeQuickOn(dir: string, on: boolean) {
  writeFileSync(join(dir, SETTING_FILE), JSON.stringify({ on }));
}
