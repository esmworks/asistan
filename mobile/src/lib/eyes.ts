import { AT_YOU, type Spot } from '@yumakbot/app/src/lib/gaze';

/**
 * How far the eyes slide for a turn of the head, as a share of the body picture: they sit on a sphere
 * of about this radius. The looks the gaze picks stay within 20 degrees, which keeps the eyes inside
 * the narrow bodies (the triangle's top, the capsule's ends) without running off them.
 */
const REACH = 0.2;

const rad = (deg: number) => (deg * Math.PI) / 180;

/**
 * Where the eyes are drawn for a look, from where they rest when the bot looks at the person, in
 * the units of `span`: right and down positive, as the screen counts.
 */
export function eyeShift(look: Spot, span: number) {
  const r = REACH * span;
  return {
    x: r * Math.sin(rad(look.yaw)),
    y: -r * (Math.sin(rad(look.pitch)) - Math.sin(rad(AT_YOU.pitch))),
  };
}
