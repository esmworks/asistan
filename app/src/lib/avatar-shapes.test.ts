import { Avatar, AVATAR_SHAPES, OBJECT_AVATARS, OLD_AVATAR_SHAPES } from '@leafbot/shared';
import { getExample, validateAvatar } from 'open-bot-avatar';
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

describe('object avatars', () => {
  it('accepts every offered object and nothing else', () => {
    for (const o of OBJECT_AVATARS) expect(Avatar.safeParse(`object:${o}`).success).toBe(true);
    expect(Avatar.safeParse('object:unicorn').success).toBe(false);
    expect(Avatar.safeParse('object:').success).toBe(false);
  });

  it('ships a valid drawing for every offered object', () => {
    for (const o of OBJECT_AVATARS) {
      const definition = getExample(o);
      expect(definition, o).toBeDefined();
      expect(validateAvatar(definition).ok, o).toBe(true);
    }
  });
});
