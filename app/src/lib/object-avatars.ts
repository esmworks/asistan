import { getExample, type AvatarDefinition } from 'open-bot-avatar';

/**
 * Plain shapes beside the engine's own objects, for a bot that should look simple. Same contract as
 * the engine's: one outline wound clockwise in a 0 0 100 100 box, and the eyes where the body has room
 * for them. The triangle's eyes sit low and close, where its body is wide enough.
 */
const OWN: Record<string, AvatarDefinition> = {
  circle: {
    version: 1,
    id: 'circle',
    name: 'Circle',
    body: { path: 'M50 14A38 38 0 0 1 88 52A38 38 0 0 1 50 90A38 38 0 0 1 12 52A38 38 0 0 1 50 14Z' },
    eyes: { x: 50, y: 48, spacing: 18, scale: 1.2 },
  },
  square: {
    version: 1,
    id: 'square',
    name: 'Square',
    body: {
      path: 'M30 16H70A14 14 0 0 1 84 30V70A14 14 0 0 1 70 84H30A14 14 0 0 1 16 70V30A14 14 0 0 1 30 16Z',
    },
    eyes: { x: 50, y: 46, spacing: 18, scale: 1.2 },
  },
  triangle: {
    version: 1,
    id: 'triangle',
    name: 'Triangle',
    body: { path: 'M43 21Q50 10 57 21L87 73Q93 85 79 85H21Q7 85 13 73Z' },
    eyes: { x: 50, y: 62, spacing: 14, scale: 1 },
  },
};

/** The drawing of an object avatar: one of the plain shapes or one of the engine's objects. */
export const objectDefinition = (id: string): AvatarDefinition | undefined => OWN[id] ?? getExample(id);
