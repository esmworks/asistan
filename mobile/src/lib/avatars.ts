import { OBJECT_AVATARS } from '@leafbot/shared';

/**
 * Which avatars the connected server takes. The phone is updated through the store, apart from the
 * server, so it may talk to an older one: 0.7.0 knew only the engine's objects, and before it a bot
 * could have no object at all. A server refuses an avatar it does not know, and the whole bot with it.
 */

/** The objects 0.7.0 took, before the plain shapes came. */
const FIRST_OBJECTS: readonly string[] = [
  'controller',
  'barbell',
  'mug',
  'lightbulb',
  'chat',
  'sprout',
  'watering-can',
];

/** The old shape name every server takes: a current one stores it as the round object. */
export const SAFE_AVATAR = 'shape:blob';

/** Whether version `v` (such as `0.7.1` or `0.7.1-dev`) is `min` or later. */
export function atLeast(v: string, min: string): boolean {
  const parts = (s: string) =>
    s
      .split(/[.-]/)
      .slice(0, 3)
      .map((n) => Number.parseInt(n, 10) || 0);
  const a = parts(v);
  const b = parts(min);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return true;
}

/** The objects a server of this version takes, in the order the app offers them; none while it is not known. */
export function objectsFor(version: string | undefined): readonly string[] {
  if (!version) return [];
  if (atLeast(version, '0.7.1')) return OBJECT_AVATARS;
  if (atLeast(version, '0.7.0')) return FIRST_OBJECTS;
  return [];
}

/** `avatar`, or the old round shape where the server would not know its object. */
export function avatarFor(avatar: string, version: string | undefined): string {
  if (!avatar.startsWith('object:')) return avatar;
  return objectsFor(version).includes(avatar.slice('object:'.length)) ? avatar : SAFE_AVATAR;
}
