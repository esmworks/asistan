import { MapPin, Pencil, Undo2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { drawMarks, markupSize, pinNotes, pins, type Mark } from '@/lib/markup';
import { cn } from '@/lib/utils';

const COLORS = ['#E5484D', '#F5A524', '#3E8BFF', '#FFFFFF'] as const;

/**
 * Drawing on a picture before it is sent: lines in a few colours, and numbered pins with a note
 * each. Saving gives a copy with the marks drawn in, as a PNG, and the pins' notes as text; the
 * original picture stays as it was.
 */
export function ImageMarkup({
  src,
  name,
  onClose,
  onSave,
}: {
  src: string;
  name: string;
  onClose(): void;
  onSave(png: Blob, notes: string): void;
}) {
  const t = useT();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [tool, setTool] = useState<'pen' | 'pin'>('pen');
  const [color, setColor] = useState<string>(COLORS[0]);
  const [editing, setEditing] = useState<number | null>(null);
  const drawing = useRef(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const img = new Image();
    img.onload = () => setImage(img);
    img.src = src;
  }, [src]);

  const size = image ? markupSize(image.naturalWidth, image.naturalHeight) : null;

  // Everything is drawn again on each change: the picture, then the marks.
  useEffect(() => {
    const c = canvas.current;
    if (!c || !image || !size) return;
    c.width = size.width;
    c.height = size.height;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(image, 0, 0, size.width, size.height);
    drawMarks(ctx, marks, size.width, size.height);
  }, [image, marks, size?.width, size?.height]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Where the pointer is, in the picture's pixels. */
  const at = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * e.currentTarget.width,
      y: ((e.clientY - r.top) / r.height) * e.currentTarget.height,
    };
  };

  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = at(e);
    if (tool === 'pin') {
      setMarks((m) => [...m, { kind: 'pin', ...p, note: '' }]);
      setEditing(pins(marks).length);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    setMarks((m) => [...m, { kind: 'stroke', color, points: [p] }]);
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const p = at(e);
    setMarks((m) => {
      const last = m.at(-1);
      if (last?.kind !== 'stroke') return m;
      return [...m.slice(0, -1), { ...last, points: [...last.points, p] }];
    });
  };
  const up = () => {
    drawing.current = false;
  };

  const pinList = pins(marks);
  const setNote = (index: number, note: string) => {
    let seen = -1;
    setMarks((m) => m.map((x) => (x.kind === 'pin' && ++seen === index ? { ...x, note } : x)));
  };

  const save = () => {
    const c = canvas.current;
    if (!c) return;
    setSaving(true);
    c.toBlob((blob) => {
      setSaving(false);
      if (blob) onSave(blob, pinNotes(marks, t('markup.notesHeading', { name })));
    }, 'image/png');
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[94vh] w-[min(1100px,96vw)] max-w-[96vw] flex-col gap-3 rounded-3xl p-4 sm:max-w-[96vw]">
        <DialogTitle className="text-base">{t('markup.title', { name })}</DialogTitle>
        <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label={t('markup.tools')}>
          <Button
            type="button"
            size="sm"
            variant={tool === 'pen' ? 'secondary' : 'ghost'}
            aria-pressed={tool === 'pen'}
            onClick={() => setTool('pen')}
          >
            <Pencil /> {t('markup.pen')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={tool === 'pin' ? 'secondary' : 'ghost'}
            aria-pressed={tool === 'pin'}
            onClick={() => setTool('pin')}
          >
            <MapPin /> {t('markup.pin')}
          </Button>
          <span className="mx-1 h-5 w-px bg-border" aria-hidden />
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={t('markup.color', { color: c })}
              aria-pressed={color === c}
              onClick={() => {
                setColor(c);
                setTool('pen');
              }}
              className={cn(
                'size-6 rounded-full border-2 border-transparent ring-1 ring-border',
                color === c && tool === 'pen' && 'border-foreground',
              )}
              style={{ background: c }}
            />
          ))}
          <span className="flex-1" />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!marks.length}
            onClick={() => {
              setMarks((m) => m.slice(0, -1));
              setEditing(null);
            }}
          >
            <Undo2 /> {t('markup.undo')}
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 sm:flex-row">
          <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-auto rounded-2xl bg-secondary/50 p-2">
            <canvas
              ref={canvas}
              aria-label={t('markup.canvas')}
              onPointerDown={down}
              onPointerMove={move}
              onPointerUp={up}
              onPointerCancel={up}
              className={cn(
                'max-h-[68vh] max-w-full touch-none rounded-xl',
                tool === 'pen' ? 'cursor-crosshair' : 'cursor-copy',
              )}
            />
          </div>
          {pinList.length > 0 && (
            <ol className="flex w-full shrink-0 flex-col gap-2 overflow-y-auto sm:w-64">
              {pinList.map((p, i) => (
                <li key={i} className="flex items-center gap-2">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-[#E5484D] text-xs font-bold text-white">
                    {i + 1}
                  </span>
                  <Input
                    autoFocus={editing === i}
                    value={p.note}
                    onChange={(e) => setNote(i, e.target.value)}
                    placeholder={t('markup.notePlaceholder')}
                    aria-label={t('markup.note', { number: i + 1 })}
                    className="h-8 rounded-lg"
                  />
                </li>
              ))}
            </ol>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('markup.cancel')}
          </Button>
          <Button type="button" onClick={save} disabled={!image || !marks.length || saving}>
            {t('markup.save')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
