import { describe, expect, it } from 'vitest';
import { atLeast, avatarFor, objectsFor, SAFE_AVATAR } from './avatars';

describe('avatars the connected server takes', () => {
  it('compares versions part by part, with or without a suffix', () => {
    expect(atLeast('0.7.1', '0.7.1')).toBe(true);
    expect(atLeast('0.7.1-dev', '0.7.1')).toBe(true);
    expect(atLeast('0.10.0', '0.7.1')).toBe(true);
    expect(atLeast('1.0.0', '0.7.1')).toBe(true);
    expect(atLeast('0.7.0', '0.7.1')).toBe(false);
    expect(atLeast('0.6.9', '0.7.0')).toBe(false);
  });

  it('offers every object to a current server, the first ones to 0.7.0 and none to older or unknown ones', () => {
    expect(objectsFor('0.7.1')).toContain('circle');
    expect(objectsFor('0.7.1')).toContain('sprout');
    expect(objectsFor('0.7.0')).toContain('sprout');
    expect(objectsFor('0.7.0')).not.toContain('circle');
    expect(objectsFor('0.6.5')).toEqual([]);
    expect(objectsFor(undefined)).toEqual([]);
  });

  it('sends the old round shape where the server would not know the object', () => {
    expect(avatarFor('object:circle', '0.7.1')).toBe('object:circle');
    expect(avatarFor('object:circle', '0.7.0')).toBe(SAFE_AVATAR);
    expect(avatarFor('object:mug', '0.7.0')).toBe('object:mug');
    expect(avatarFor('object:mug', '0.6.5')).toBe(SAFE_AVATAR);
    expect(avatarFor('object:mug', undefined)).toBe(SAFE_AVATAR);
    expect(avatarFor('shape:blob', '0.6.5')).toBe('shape:blob');
    expect(avatarFor('data:image/png;base64,AAAA', undefined)).toBe('data:image/png;base64,AAAA');
  });
});
