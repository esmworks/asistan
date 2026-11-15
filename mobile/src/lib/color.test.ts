import { describe, expect, it } from 'vitest';
import { hexToOklab, mixWithBlack, oklabToHex } from './color';

describe('color', () => {
  it('reads a hex color as OKLab', () => {
    const [L, a, b] = hexToOklab('#e2725b')!;
    expect(L).toBeCloseTo(0.677, 2);
    expect(a).toBeCloseTo(0.121, 2);
    expect(b).toBeCloseTo(0.078, 2);
    expect(hexToOklab('#fff')![0]).toBeCloseTo(1, 3);
    expect(hexToOklab('red')).toBeNull();
  });

  it('goes back to the same hex', () => {
    for (const hex of ['#e2725b', '#2f9e6e', '#8a5cf6', '#000000', '#ffffff']) {
      expect(oklabToHex(hexToOklab(hex)!)).toBe(hex);
    }
  });

  it('darkens like the web user bubble', () => {
    // The browser computes oklab(0.555 0.099 0.064) for this bot color.
    const [L, a, b] = hexToOklab(mixWithBlack('#e2725b', 0.82))!;
    expect(L).toBeCloseTo(0.555, 2);
    expect(a).toBeCloseTo(0.099, 2);
    expect(b).toBeCloseTo(0.064, 2);
    expect(mixWithBlack('tomato', 0.82)).toBe('tomato');
  });
});
