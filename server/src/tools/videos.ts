import type { Bot, Thread } from '@yumakbot/shared';
import { z } from 'zod';
import type { AppTool } from '../engine/types';
import type { T } from '../i18n';
import type { Services } from '../services';
import { VIDEO_SECONDS, VideoError } from '../services/videos';
import { workspacePaths } from '../workspace';
import { postFiles, writeNewFile } from './files';
import type { Define } from './index';

/** Videos one turn may make: each is paid for by the second, and takes minutes. */
export const MAX_VIDEOS_PER_TURN = 1;

const stamp = (d: Date) => d.toISOString().slice(0, 19).replace('T', '-').replace(/:/g, '');

/**
 * `video_create`: makes a short video from a description with a provider whose key the person
 * saved, keeps it in the conversation's folder and hands it to the person, in one step.
 */
export function videoTool(opts: {
  def: Define;
  services: Services;
  dataDir: string;
  bot: Bot;
  thread: Pick<Thread, 'id' | 'kind' | 'botId'> & { userId?: string | null };
  signal: AbortSignal;
  t: T;
}): AppTool {
  const { def, services, dataDir, bot, thread, signal, t } = opts;
  let made = 0;
  return def(
    'video_create',
    {
      prompt: z.string().trim().min(1).max(4000),
      seconds: z.number().int().min(VIDEO_SECONDS.min).max(VIDEO_SECONDS.max).optional(),
      shape: z.enum(['landscape', 'portrait', 'square']).optional(),
      caption: z.string().max(2000).optional(),
    },
    async ({ prompt, seconds, shape, caption }) => {
      if (made >= MAX_VIDEOS_PER_TURN) return t('tool.videoLimit', { max: MAX_VIDEOS_PER_TURN });
      made++;
      let video;
      try {
        video = await services.videos.create(prompt, { seconds, shape, signal });
      } catch (err) {
        if (!(err instanceof VideoError)) throw err;
        if (err.reason === 'noKey') {
          made--;
          return t('tool.videoNoKey');
        }
        return t(`tool.videoFailed.${err.reason}`, { provider: err.provider, message: err.message });
      }
      const dir = workspacePaths(dataDir, bot.id, thread.id, bot.groupId).threadDir;
      const path = await writeNewFile(
        dir,
        `${t('tool.videoFileBase')}-${stamp(new Date())}`,
        'mp4',
        video.data,
      );
      const { files, moved } = await postFiles({ services, dataDir, bot, thread, paths: [path], caption, t });
      return t(moved ? 'tool.videoCreatedMain' : 'tool.videoCreated', {
        name: files[0]!.name,
        path,
        provider: video.provider,
        seconds: video.seconds,
      });
    },
  );
}
