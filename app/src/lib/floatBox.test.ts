import { describe, expect, it } from 'vitest';
import { clampFloat, defaultFloat, FLOAT, floatHeight, resizeFloat } from './floatBox';

describe('floating browser window', () => {
  it('opens in the top right corner, below the header', () => {
    const b = defaultFloat(1440, 900);
    expect(b.width).toBe(FLOAT.default);
    expect(b.x + b.width).toBe(1440 - FLOAT.margin);
    expect(b.y).toBe(FLOAT.top);
  });

  it('stays inside the window when moved past an edge', () => {
    const b = clampFloat({ x: -200, y: 5000, width: 400 }, 1200, 800);
    expect(b.x).toBe(FLOAT.margin);
    expect(b.y + floatHeight(b.width)).toBe(800 - FLOAT.margin);
  });

  it('shrinks to fit a smaller window, but not below its minimum', () => {
    const b = clampFloat({ x: 0, y: 0, width: 1000 }, 700, 900);
    expect(b.width).toBe(700 - 2 * FLOAT.margin);
    expect(clampFloat({ x: 0, y: 0, width: 50 }, 1200, 800).width).toBe(FLOAT.min);
    const short = clampFloat({ x: 0, y: 0, width: 1000 }, 1600, 400);
    expect(floatHeight(short.width)).toBeLessThanOrEqual(400 - 2 * FLOAT.margin + 1);
  });

  it('keeps the right edge in place while resizing from the left', () => {
    const start = { x: 600, y: 100, width: 400 };
    const wider = resizeFloat(start, -150, 1440, 900);
    expect(wider.width).toBe(550);
    expect(wider.x + wider.width).toBe(1000);
    const narrow = resizeFloat(start, 1000, 1440, 900);
    expect(narrow.width).toBe(FLOAT.min);
    expect(narrow.x + narrow.width).toBe(1000);
  });
});
