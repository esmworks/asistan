import { EXPRESSIONS } from '@norbert_bodziony/bloub';
import { describe, expect, it } from 'vitest';
import { uprightFace } from './faces';
import { AT_YOU } from './gaze';

describe('upright faces', () => {
  it('hold the head straight, look at the person and never slant both eyes the same way', () => {
    for (const { id } of EXPRESSIONS) {
      const face = uprightFace(id);
      expect(face.gaze).toEqual({ yaw: AT_YOU.yaw, pitch: AT_YOU.pitch, roll: 0 });
      const [a, b] = face.eyes;
      expect((a.tilt ?? 0) + (b.tilt ?? 0)).toBe(0);
    }
  });

  it('keep a smile', () => {
    const happy = uprightFace('heureux');
    expect(happy.eyes[0].tilt).toBe(14);
    expect(happy.eyes[1].tilt).toBe(-14);
  });

  it('go by an id the engine has no fit for, so it centres the eyes', () => {
    expect(EXPRESSIONS.some((e) => e.id === uprightFace('neutre').id)).toBe(false);
  });

  it('are the same object every time', () => {
    expect(uprightFace('curieux')).toBe(uprightFace('curieux'));
  });
});
