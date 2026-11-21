import {
  FillType,
  PaintStyle,
  Skia,
  StrokeCap,
  TileMode,
  type SkCanvas,
  type SkPath,
  type SkPicture,
} from '@shopify/react-native-skia';
import type { AvatarFrame, EyeMark, Matrix } from 'open-bot-avatar';

/**
 * Paints an object avatar's frame with Skia. The avatar engine hands out each frame as plain path
 * strings and matrices, back to front, in a 0 0 100 100 box; the phone has no browser canvas to give
 * it, so this draws the same list itself: the body's cross-sections in the body colour, the eyes in
 * theirs, and the ribbons with their gradients.
 */

/** Parsed cross-sections, by the engine's id for equal geometry: a frame reuses most of the last one's. */
const sections = new Map<string, SkPath>();
/** Past this many the cache starts again, so a long session of changing avatars does not grow it. */
const MAX_SECTIONS = 4096;

function section(id: string, d: string, evenOdd: boolean): SkPath | null {
  let path = sections.get(id);
  if (!path) {
    if (sections.size > MAX_SECTIONS) sections.clear();
    const parsed = Skia.Path.MakeFromSVGString(d);
    if (!parsed) return null;
    path = evenOdd ? Skia.PathBuilder.MakeFromPath(parsed).setFillType(FillType.EvenOdd).build() : parsed;
    sections.set(id, path);
  }
  return path;
}

/** An SVG-style matrix (a b c d e f) as the row-major 3 × 3 Skia takes. */
const matrix3 = ([a, b, c, d, e, f]: Matrix) => [a, c, e, b, d, f, 0, 0, 1];

function eye(canvas: SkCanvas, mark: EyeMark, ink: string) {
  const paint = Skia.Paint();
  paint.setAntiAlias(true);
  paint.setColor(Skia.Color(ink));
  if (mark.shape === 'pill') {
    const box = Skia.XYWHRect(mark.x, mark.y, mark.width, mark.height);
    canvas.drawRRect(Skia.RRectXY(box, mark.radius, mark.radius), paint);
    return;
  }
  const path = Skia.Path.MakeFromSVGString(mark.d);
  if (!path) return;
  if (mark.shape === 'arc') {
    paint.setStyle(PaintStyle.Stroke);
    paint.setStrokeWidth(mark.strokeWidth);
    paint.setStrokeCap(StrokeCap.Round);
  }
  canvas.drawPath(path, paint);
}

/**
 * One frame as a picture `size` points wide. `extent` is the square of the 0 0 100 100 box the
 * picture covers, larger than the box: a hop or a ribbon reaches past the body's own square.
 */
export function framePicture(
  frame: AvatarFrame,
  size: number,
  extent: { x: number; y: number; size: number },
): SkPicture {
  const scale = size / 100;
  const recorder = Skia.PictureRecorder();
  const canvas = recorder.beginRecording(Skia.XYWHRect(0, 0, extent.size * scale, extent.size * scale));
  canvas.scale(scale, scale);
  canvas.translate(-extent.x, -extent.y);
  canvas.concat(matrix3(frame.root));

  const body = Skia.Paint();
  body.setAntiAlias(true);
  body.setColor(Skia.Color(frame.color));
  const paths = new Map(frame.paths.map((p) => [p.id, p]));

  for (const shape of frame.shapes) {
    canvas.save();
    canvas.concat(matrix3(shape.matrix));
    if (shape.kind === 'slice') {
      const p = paths.get(shape.path);
      const path = p && section(p.id, p.d, p.evenOdd);
      if (path) canvas.drawPath(path, body);
    } else if (shape.kind === 'eye') {
      eye(canvas, shape.mark, frame.ink);
    } else {
      const g = shape.gradient;
      const paint = Skia.Paint();
      paint.setAntiAlias(true);
      paint.setShader(
        Skia.Shader.MakeLinearGradient(
          { x: g.x1, y: g.y1 },
          { x: g.x2, y: g.y2 },
          g.stops.map((c) => Skia.Color(c)),
          g.stops.map((_, i) => i / (g.stops.length - 1)),
          TileMode.Clamp,
        ),
      );
      const path = Skia.Path.MakeFromSVGString(shape.d);
      if (path) canvas.drawPath(path, paint);
    }
    canvas.restore();
  }
  return recorder.finishRecordingAsPicture();
}
