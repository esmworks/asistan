import { EXPRESSION_BY_ID, type BotExpression, type ExpressionId } from '@norbert_bodziony/bloub';
import { AT_YOU } from './gaze';

const upright = new Map<ExpressionId, BotExpression>();

/**
 * A face with the head held straight, looking at the person. The catalogue tilts the head on some
 * faces (`neutre` by 13 degrees, `curieux` by 15), slants both eyes the same way on others and looks
 * off to a side (`neutre` up and to the right); on a plush that sits flat those eyes just look crooked.
 * A moving avatar is steered by its gaze anyway; this is what one at rest shows. Mirrored slants stay:
 * they shape a smile or a frown.
 *
 * The engine also moves the eyes by a fit it worked out for each face on each body, made for the
 * face's own sideways look. With the head straight that fit only pushes the eyes off centre, onto the
 * cloud's top right bump and towards the capsule's end. So the face goes by an id the engine does not
 * know, and it places the eyes as for its plain face, in the middle of the body.
 *
 * One object per face, so handing it over again does not restart the move to it.
 */
export function uprightFace(id: ExpressionId): BotExpression {
  let face = upright.get(id);
  if (face) return face;
  const base = EXPRESSION_BY_ID.get(id);
  if (!base) throw new Error(`Unknown face ${id}`);
  const [a, b] = base.eyes;
  const mirrored = (a.tilt ?? 0) === -(b.tilt ?? 0);
  face = {
    ...base,
    id: `${id}:upright` as ExpressionId,
    gaze: { yaw: AT_YOU.yaw, pitch: AT_YOU.pitch, roll: 0 },
    eyes: mirrored
      ? base.eyes
      : [
          { ...a, tilt: 0 },
          { ...b, tilt: 0 },
        ],
  };
  upright.set(id, face);
  return face;
}
