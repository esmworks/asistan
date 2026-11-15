import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  bounds: Rect;
  maximized: boolean;
}

export const DEFAULT_SIZE = { width: 1440, height: 920 } as const;
export const MIN_SIZE = { width: 960, height: 600 } as const;

const whole = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

/** A saved state, or null when the file holds something else. */
export function parseWindowState(raw: unknown): WindowState | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const b = (value as { bounds?: Partial<Rect> } | null)?.bounds;
  if (!b || typeof b !== 'object') return null;
  const { x, y, width, height } = b;
  if (!whole(x) || !whole(y) || !whole(width) || !whole(height) || width <= 0 || height <= 0) return null;
  return {
    bounds: { x, y, width, height },
    maximized: (value as { maximized?: unknown }).maximized === true,
  };
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return w * h;
}

/**
 * Where the window opens: where it was, moved and shrunk onto the screen it overlapped most, so a
 * window saved on a monitor that is gone, or at a resolution no longer there, stays reachable.
 * A window off every screen is centred on the first (primary) one. `screens` are work areas.
 */
export function resolveWindowState(
  saved: WindowState | null,
  screens: readonly Rect[],
): {
  bounds: Partial<Rect> & { width: number; height: number };
  maximized: boolean;
} {
  const areas = screens.filter((a) => a.width > 0 && a.height > 0);
  const primary = areas[0];
  if (!saved || !primary) {
    return {
      bounds: {
        width: primary ? Math.min(DEFAULT_SIZE.width, primary.width) : DEFAULT_SIZE.width,
        height: primary ? Math.min(DEFAULT_SIZE.height, primary.height) : DEFAULT_SIZE.height,
      },
      maximized: false,
    };
  }
  let target = primary;
  let best = 0;
  for (const area of areas) {
    const o = overlap(saved.bounds, area);
    if (o > best) {
      best = o;
      target = area;
    }
  }
  const width = clamp(saved.bounds.width, Math.min(MIN_SIZE.width, target.width), target.width);
  const height = clamp(saved.bounds.height, Math.min(MIN_SIZE.height, target.height), target.height);
  const x =
    best === 0
      ? target.x + Math.round((target.width - width) / 2)
      : clamp(saved.bounds.x, target.x, target.x + target.width - width);
  const y =
    best === 0
      ? target.y + Math.round((target.height - height) / 2)
      : clamp(saved.bounds.y, target.y, target.y + target.height - height);
  return { bounds: { x, y, width, height }, maximized: saved.maximized };
}

const file = (dir: string) => join(dir, 'window-state.json');

export function readWindowState(dir: string): WindowState | null {
  try {
    return parseWindowState(readFileSync(file(dir), 'utf8'));
  } catch {
    return null;
  }
}

/** Written to a side file and moved into place, so a crash mid-write leaves the old state. */
export function writeWindowState(dir: string, state: WindowState) {
  const target = file(dir);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, target);
  } catch {
    rmSync(tmp, { force: true });
  }
}
