/** A mark drawn on a picture, in the picture's own pixels. */
export type Mark =
  | { kind: 'stroke'; color: string; points: { x: number; y: number }[] }
  | { kind: 'pin'; x: number; y: number; note: string };

/** Pictures larger than this are drawn on at this size, so the result stays a sensible file. */
export const MARKUP_MAX_SIDE = 2400;

/** The size the picture is drawn on at: its own, made smaller when a side is over the limit. */
export function markupSize(width: number, height: number, max = MARKUP_MAX_SIDE) {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** A line and a pin sized to the picture, so they read the same on a small and a large one. */
export const lineWidth = (width: number, height: number) =>
  Math.max(2, Math.round(Math.max(width, height) / 250));
export const pinRadius = (width: number, height: number) =>
  Math.max(10, Math.round(Math.max(width, height) / 60));

/** Draws the marks over what is already on the canvas: lines, then numbered pins on top. */
export function drawMarks(
  ctx: CanvasRenderingContext2D,
  marks: readonly Mark[],
  width: number,
  height: number,
) {
  const line = lineWidth(width, height);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const m of marks) {
    if (m.kind !== 'stroke' || !m.points.length) continue;
    ctx.strokeStyle = m.color;
    ctx.lineWidth = line;
    ctx.beginPath();
    ctx.moveTo(m.points[0]!.x, m.points[0]!.y);
    for (const p of m.points.slice(1)) ctx.lineTo(p.x, p.y);
    if (m.points.length === 1) ctx.lineTo(m.points[0]!.x + 0.1, m.points[0]!.y);
    ctx.stroke();
  }
  const r = pinRadius(width, height);
  pins(marks).forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#E5484D';
    ctx.fill();
    ctx.lineWidth = Math.max(2, r / 5);
    ctx.strokeStyle = '#FFFFFF';
    ctx.stroke();
    ctx.fillStyle = '#FFFFFF';
    ctx.font = `bold ${Math.round(r * 1.1)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), p.x, p.y + 1);
  });
}

export const pins = (marks: readonly Mark[]) =>
  marks.filter((m): m is Extract<Mark, { kind: 'pin' }> => m.kind === 'pin');

/**
 * The notes left on pins, numbered as the pins are, to go with the marked picture in the message.
 * Pins without a note keep their number, so the numbers match what is drawn.
 */
export function pinNotes(marks: readonly Mark[], heading: string): string {
  const lines = pins(marks)
    .map((p, i) => (p.note.trim() ? `${i + 1}. ${p.note.trim()}` : ''))
    .filter(Boolean);
  return lines.length ? `${heading}\n${lines.join('\n')}` : '';
}

/** `photo.jpg` → `photo-marked.png`: the marked copy, beside the original. */
export function markedName(name: string, suffix: string): string {
  const base = name.replace(/\.[^.]+$/, '');
  return `${base}-${suffix}.png`;
}
