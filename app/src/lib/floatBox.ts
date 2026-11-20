/** The browser's own size; its picture keeps this shape at any size. */
export const VIEW_RATIO = 1280 / 800;

/**
 * The floating browser window: its left and top edges and its width in px. The height follows
 * from the width, so the picture keeps the browser's shape and pointer positions map one to one.
 */
export interface FloatBox {
  x: number;
  y: number;
  width: number;
}

export const FLOAT = {
  min: 280,
  default: 440,
  /** Space kept free along the window's edges. */
  margin: 12,
  /** Below the chat's header, so the window starts over the bot panel and not over the composer. */
  top: 72,
  /** The title bar and borders above and around the picture. */
  chrome: 48,
} as const;

export function floatHeight(width: number): number {
  return Math.round(FLOAT.chrome + width / VIEW_RATIO);
}

function widthIn(width: number, vw: number, vh: number): number {
  const fit = Math.min(vw - 2 * FLOAT.margin, (vh - 2 * FLOAT.margin - FLOAT.chrome) * VIEW_RATIO);
  return Math.round(Math.max(FLOAT.min, Math.min(width, fit)));
}

/** Keeps the window inside a viewport of vw × vh, shrinking it when the viewport is too small. */
export function clampFloat(box: FloatBox, vw: number, vh: number): FloatBox {
  const width = widthIn(box.width, vw, vh);
  const right = Math.max(FLOAT.margin, vw - width - FLOAT.margin);
  const bottom = Math.max(FLOAT.margin, vh - floatHeight(width) - FLOAT.margin);
  return {
    x: Math.round(Math.min(Math.max(box.x, FLOAT.margin), right)),
    y: Math.round(Math.min(Math.max(box.y, FLOAT.margin), bottom)),
    width,
  };
}

/** Where the window first opens: the top right corner. */
export function defaultFloat(vw: number, vh: number): FloatBox {
  return clampFloat({ x: vw, y: FLOAT.top, width: FLOAT.default }, vw, vh);
}

/** Resizing from the bottom left corner, `dx` px to the right: the right edge stays put. */
export function resizeFloat(start: FloatBox, dx: number, vw: number, vh: number): FloatBox {
  const width = widthIn(start.width - dx, vw, vh);
  return clampFloat({ x: start.x + start.width - width, y: start.y, width }, vw, vh);
}

const KEY = 'leafbot.browserFloat';

export function loadFloat(): FloatBox | null {
  try {
    const b = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<FloatBox> | null;
    return b && [b.x, b.y, b.width].every(Number.isFinite) ? (b as FloatBox) : null;
  } catch {
    return null;
  }
}

export function saveFloat(box: FloatBox): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(box));
  } catch {
    // Storage may be unavailable; the window then opens in its default place next time.
  }
}
