import { Avatar, AVATAR_SHAPES, OLD_AVATAR_SHAPES } from '@yumakbot/shared';
import { describe, expect, it } from 'vitest';

describe('avatar shapes', () => {
  it('accepts every offered shape and keeps accepting the ones no longer offered', () => {
    for (const s of [...AVATAR_SHAPES, ...OLD_AVATAR_SHAPES]) {
      expect(Avatar.safeParse(`shape:${s}`).success).toBe(true);
    }
    expect(Avatar.safeParse('shape:unicorn').success).toBe(false);
  });

  it('offers no shape twice', () => {
    expect(new Set(AVATAR_SHAPES).size).toBe(AVATAR_SHAPES.length);
    expect(AVATAR_SHAPES.some((s) => (OLD_AVATAR_SHAPES as readonly string[]).includes(s))).toBe(false);
  });
});
