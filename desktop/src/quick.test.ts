import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  claimQuickKey,
  isThreadId,
  quickBounds,
  QUICK_KEYS,
  quickUrl,
  readQuickOn,
  writeQuickOn,
} from './quick';

describe('claimQuickKey', () => {
  it('takes the first shortcut that is free', () => {
    const tried: string[] = [];
    const key = claimQuickKey((k) => {
      tried.push(k);
      return k === 'CommandOrControl+Alt+Shift+Space';
    });
    expect(key).toBe('CommandOrControl+Alt+Shift+Space');
    expect(tried).toEqual(['CommandOrControl+Shift+Space', 'CommandOrControl+Alt+Shift+Space']);
  });

  it('gives null when every shortcut is taken or refused', () => {
    expect(
      claimQuickKey(() => {
        throw new Error('unknown accelerator');
      }),
    ).toBeNull();
    expect(claimQuickKey(() => false)).toBeNull();
  });
});

describe('quickBounds', () => {
  it('centres the window a fifth of the way down the screen', () => {
    expect(quickBounds({ x: 0, y: 25, width: 1440, height: 875 })).toEqual({
      x: 490,
      y: 200,
      width: 460,
      height: 520,
    });
  });

  it('stays inside a screen placed left of the main one', () => {
    const b = quickBounds({ x: -1280, y: 0, width: 1280, height: 720 });
    expect(b.x).toBe(-870);
    expect(b.y + b.height).toBeLessThanOrEqual(720);
  });

  it('shrinks to a screen smaller than the window', () => {
    expect(quickBounds({ x: 0, y: 0, width: 400, height: 300 })).toEqual({
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });
  });
});

describe('quickUrl', () => {
  it('asks the page for the quick view', () => {
    expect(quickUrl('http://127.0.0.1:4319')).toBe('http://127.0.0.1:4319/?quick=1');
    expect(quickUrl('https://bots.example.com/')).toBe('https://bots.example.com/?quick=1');
  });
});

describe('isThreadId', () => {
  it('accepts ids and refuses anything else', () => {
    expect(isThreadId('a1B2-c3_d4')).toBe(true);
    expect(isThreadId('../etc')).toBe(false);
    expect(isThreadId('')).toBe(false);
    expect(isThreadId(42)).toBe(false);
  });
});

describe('quick shortcut setting', () => {
  it('takes no key the system keeps for itself', () => {
    expect(QUICK_KEYS).not.toContain('Alt+Space');
  });

  it('is on until turned off, and stays as last set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'leafbot-quick-'));
    try {
      expect(readQuickOn(dir)).toBe(true);
      writeQuickOn(dir, false);
      expect(readQuickOn(dir)).toBe(false);
      writeQuickOn(dir, true);
      expect(readQuickOn(dir)).toBe(true);
      writeFileSync(join(dir, 'quick.json'), '{ bozuk');
      expect(readQuickOn(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
