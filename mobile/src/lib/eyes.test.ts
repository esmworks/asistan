import { describe, expect, it } from 'vitest';
import { eyeShift } from './eyes';

describe('eyeShift', () => {
  it('leaves the eyes where they rest when the bot looks at the person', () => {
    const at = eyeShift({ yaw: 0, pitch: 8 }, 100);
    expect(at.x).toBeCloseTo(0);
    expect(at.y).toBeCloseTo(0);
  });

  it('moves them right for a look to the right and up for a look up', () => {
    expect(eyeShift({ yaw: 12, pitch: 8 }, 100).x).toBeGreaterThan(0);
    expect(eyeShift({ yaw: -12, pitch: 8 }, 100).x).toBeLessThan(0);
    expect(eyeShift({ yaw: 0, pitch: 20 }, 100).y).toBeLessThan(0);
    expect(eyeShift({ yaw: 0, pitch: -5 }, 100).y).toBeGreaterThan(0);
  });

  it('keeps the widest look a small step, so the eyes stay on a narrow body', () => {
    const far = eyeShift({ yaw: 18, pitch: -8 }, 100);
    expect(Math.abs(far.x)).toBeLessThan(8);
    expect(Math.abs(far.y)).toBeLessThan(8);
  });
});
