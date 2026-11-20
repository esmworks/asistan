import { readFileSync } from 'node:fs';
import type { Bot, Thread } from '@yumakbot/shared';
import PptxGenJS from 'pptxgenjs';
import { z } from 'zod';
import type { AppTool } from '../engine/types';
import type { T } from '../i18n';
import type { Services } from '../services';
import { imageType } from '../services/images';
import { workspacePaths } from '../workspace';
import { botFile, postFiles, writeNewFile } from './files';
import type { Define } from './index';

/** The slide's size in inches: 16:9, PowerPoint's "Widescreen". */
const W = 13.333;
const H = 7.5;
const MARGIN = 0.6;
const MAX_SLIDES = 40;
/** A picture larger than this would make the file heavy to send. */
const MAX_PICTURE = 10 * 1024 * 1024;
const FONT = 'Calibri';

const THEMES = {
  light: { background: 'FFFFFF', text: '1F2328', muted: '59636E' },
  dark: { background: '1B1B1B', text: 'F2F2F2', muted: 'A8A8A8' },
} as const;

const Slide = z.object({
  layout: z.enum(['title', 'section', 'content', 'image']).optional(),
  title: z.string().max(300).optional(),
  subtitle: z.string().max(500).optional(),
  bullets: z.array(z.string().max(500)).max(12).optional(),
  text: z.string().max(2000).optional(),
  image: z.string().max(2000).optional(),
  notes: z.string().max(4000).optional(),
});
export type SlideInput = z.infer<typeof Slide>;

/** A picture's size in pixels, read from its header; null for a file that is not one. */
export function pictureSize(data: Buffer): { width: number; height: number } | null {
  const type = imageType(data);
  if (type === 'png' && data.length >= 24)
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if (type === 'gif' && data.length >= 10)
    return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  if (type === 'jpg') {
    // The frame header (SOF0 to SOF15, but not DHT, JPG or DAC) holds the size.
    let i = 2;
    while (i + 9 < data.length) {
      if (data[i] !== 0xff) return null;
      const marker = data[i + 1]!;
      const length = data.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: data.readUInt16BE(i + 7), height: data.readUInt16BE(i + 5) };
      }
      i += 2 + length;
    }
  }
  return null;
}

/** The largest box of the picture's shape that fits in the area, centred in it. */
export function fitBox(
  size: { width: number; height: number },
  area: { x: number; y: number; w: number; h: number },
) {
  const scale = Math.min(area.w / size.width, area.h / size.height);
  const w = size.width * scale;
  const h = size.height * scale;
  return { x: area.x + (area.w - w) / 2, y: area.y + (area.h - h) / 2, w, h };
}

interface Picture {
  data: string;
  width: number;
  height: number;
}

/** The deck as a PowerPoint file, which Keynote and Google Slides open too. */
export async function buildDeck(o: {
  title: string;
  slides: SlideInput[];
  theme: keyof typeof THEMES;
  accent: string;
  picture: (path: string) => Picture;
}): Promise<Buffer> {
  const theme = THEMES[o.theme];
  const pres = new PptxGenJS();
  pres.layout = 'LAYOUT_WIDE';
  pres.title = o.title;
  const text = (size: number, extra: PptxGenJS.TextPropsOptions = {}): PptxGenJS.TextPropsOptions => ({
    fontFace: FONT,
    fontSize: size,
    color: theme.text,
    valign: 'top',
    margin: 0,
    fit: 'shrink',
    ...extra,
  });
  for (const [i, s] of o.slides.entries()) {
    const slide = pres.addSlide();
    slide.background = { color: theme.background };
    const layout =
      s.layout ?? (i === 0 ? 'title' : s.image && !s.bullets?.length && !s.text ? 'image' : 'content');
    const image = s.image ? o.picture(s.image) : null;
    const place = (area: { x: number; y: number; w: number; h: number }) => {
      if (!image) return;
      slide.addImage({ data: image.data, ...fitBox(image, area) });
    };
    if (layout === 'title' || layout === 'section') {
      const top = layout === 'title' ? H * 0.32 : H * 0.38;
      slide.addShape(pres.ShapeType.rect, {
        x: MARGIN,
        y: top - 0.35,
        w: 1.2,
        h: 0.08,
        fill: { color: o.accent },
        line: { color: o.accent },
      });
      slide.addText(s.title ?? '', {
        ...text(layout === 'title' ? 44 : 36, { bold: true }),
        x: MARGIN,
        y: top,
        w: W - 2 * MARGIN,
        h: 1.6,
      });
      if (s.subtitle) {
        slide.addText(s.subtitle, {
          ...text(20, { color: theme.muted }),
          x: MARGIN,
          y: top + 1.7,
          w: W - 2 * MARGIN,
          h: 1.2,
        });
      }
    } else {
      slide.addText(s.title ?? '', {
        ...text(30, { bold: true }),
        x: MARGIN,
        y: MARGIN,
        w: W - 2 * MARGIN,
        h: 0.9,
      });
      const body = { x: MARGIN, y: MARGIN + 1.2, w: W - 2 * MARGIN, h: H - MARGIN * 2 - 1.2 };
      if (layout === 'image') {
        place(body);
      } else {
        const hasWords = !!s.bullets?.length || !!s.text;
        const words = image && hasWords ? { ...body, w: body.w * 0.55 } : body;
        if (image) place(hasWords ? { ...body, x: body.x + body.w * 0.6, w: body.w * 0.4 } : body);
        const runs: PptxGenJS.TextProps[] = [
          ...(s.text ? [{ text: s.text, options: { breakLine: true, paraSpaceAfter: 10 } }] : []),
          ...(s.bullets ?? []).map((b) => ({
            text: b,
            options: { bullet: { indent: 18 }, breakLine: true, paraSpaceAfter: 8 },
          })),
        ];
        if (runs.length) slide.addText(runs, { ...text(20), ...words });
      }
    }
    if (s.notes) slide.addNotes(s.notes);
  }
  return (await pres.write({ outputType: 'nodebuffer' })) as Buffer;
}

/** A file name from the deck's title: its letters and digits, joined by dashes. */
const nameFrom = (title: string) =>
  title
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'deck';

/**
 * `slides_create`: makes a slide deck from the slides the bot writes (titles, points, notes and
 * pictures from its folders) as a PowerPoint file, keeps it in the conversation's folder and
 * hands it to the person. It costs nothing and reaches nothing outside.
 */
export function slidesTool(opts: {
  def: Define;
  services: Services;
  dataDir: string;
  bot: Bot;
  thread: Pick<Thread, 'id' | 'kind' | 'botId'> & { userId?: string | null };
  t: T;
}): AppTool {
  const { def, services, dataDir, bot, thread, t } = opts;
  return def(
    'slides_create',
    {
      title: z.string().trim().min(1).max(200),
      slides: z.array(Slide).min(1).max(MAX_SLIDES),
      theme: z.enum(['light', 'dark']).optional(),
      accent: z
        .string()
        .regex(/^#?[0-9a-fA-F]{6}$/)
        .optional(),
      caption: z.string().max(2000).optional(),
    },
    async ({ title, slides, theme, accent, caption }) => {
      const picture = (path: string): Picture => {
        const { full, size } = botFile(dataDir, bot, thread.id, path, t);
        if (size > MAX_PICTURE) throw new Error(t('tool.slidesPictureLarge', { path }));
        const data = readFileSync(full);
        const type = imageType(data);
        const dims = type && type !== 'webp' ? pictureSize(data) : null;
        if (!type || !dims) throw new Error(t('tool.slidesPictureType', { path }));
        const mime = type === 'jpg' ? 'image/jpeg' : `image/${type}`;
        return { data: `${mime};base64,${data.toString('base64')}`, ...dims };
      };
      let deck: Buffer;
      try {
        deck = await buildDeck({
          title,
          slides,
          theme: theme ?? 'light',
          accent: (accent ?? '#2F7D5B').replace('#', '').toUpperCase(),
          picture,
        });
      } catch (err) {
        return (err as Error).message;
      }
      const dir = workspacePaths(dataDir, bot.id, thread.id, bot.groupId).threadDir;
      const path = await writeNewFile(dir, nameFrom(title), 'pptx', deck);
      const { files, moved } = await postFiles({ services, dataDir, bot, thread, paths: [path], caption, t });
      return t(moved ? 'tool.slidesCreatedMain' : 'tool.slidesCreated', {
        name: files[0]!.name,
        path,
        count: slides.length,
      });
    },
    'internal',
  );
}
