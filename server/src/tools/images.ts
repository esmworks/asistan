import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Bot, Thread } from '@yumakbot/shared';
import { z } from 'zod';
import type { AppTool } from '../engine/types';
import type { T } from '../i18n';
import type { Services } from '../services';
import { ImageError } from '../services/images';
import { workspacePaths } from '../workspace';
import { postFiles } from './files';
import type { Define } from './index';

/** Pictures one turn may make: each one is paid for, and a looping bot must not run up a bill. */
export const MAX_IMAGES_PER_TURN = 4;

/** `2026-11-17-153045`: a name that sorts by when the picture was made. */
const stamp = (d: Date) => d.toISOString().slice(0, 19).replace('T', '-').replace(/:/g, '');

/**
 * `image_create`: makes a picture from a description with a provider whose key the person saved,
 * keeps it in the conversation's folder and hands it to the person as a card, in one step.
 */
export function imageTool(opts: {
  def: Define;
  services: Services;
  dataDir: string;
  bot: Bot;
  thread: Pick<Thread, 'id' | 'kind'>;
  signal: AbortSignal;
  t: T;
}): AppTool {
  const { def, services, dataDir, bot, thread, signal, t } = opts;
  let made = 0;
  return def(
    'image_create',
    {
      prompt: z.string().trim().min(1).max(4000),
      shape: z.enum(['square', 'landscape', 'portrait']).optional(),
      caption: z.string().max(2000).optional(),
    },
    async ({ prompt, shape, caption }) => {
      if (made >= MAX_IMAGES_PER_TURN) return t('tool.imageLimit', { max: MAX_IMAGES_PER_TURN });
      made++;
      // The provider the bot already runs on goes first, so the person pays a single account.
      const prefer = bot.engine === 'pi' ? bot.model.split('/')[0] : undefined;
      let image;
      try {
        image = await services.images.create(prompt, { shape, prefer, signal });
      } catch (err) {
        if (!(err instanceof ImageError)) throw err;
        if (err.reason === 'noKey') {
          made--;
          return t('tool.imageNoKey');
        }
        return t(`tool.imageFailed.${err.reason}`, { provider: err.provider, message: err.message });
      }
      const dir = workspacePaths(dataDir, bot.id, thread.id, bot.groupId).threadDir;
      const base = `${t('tool.imageFileBase')}-${stamp(new Date())}`;
      let path = '';
      for (let n = 1; ; n++) {
        path = join(dir, `${base}${n === 1 ? '' : `-${n}`}.${image.ext}`);
        try {
          await writeFile(path, image.data, { flag: 'wx', mode: 0o600 });
          break;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || n >= 100) throw err;
        }
      }
      const { files, moved } = await postFiles({ services, dataDir, bot, thread, paths: [path], caption, t });
      return t(moved ? 'tool.imageCreatedMain' : 'tool.imageCreated', {
        name: files[0]!.name,
        path,
        provider: image.provider,
      });
    },
  );
}
