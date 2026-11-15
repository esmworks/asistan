import { constants, realpathSync, statSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Bot, MessageFile } from '@yumakbot/shared';
import { z } from 'zod';
import type { AppTool } from '../engine/types';
import type { T } from '../i18n';
import type { Services } from '../services';
import { safeFileName } from '../uploads';
import { workspacePaths } from '../workspace';
import type { Define } from './index';
import { bundlePage } from './page-bundle';

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};
const inside = (path: string, root: string) => path === root || path.startsWith(root + sep);

/**
 * A file in the bot's own folders, by the path the bot gave (relative to its working folder or
 * absolute): its own folder, its group's and its project folder. Anything else is refused.
 * `served` says whether the library can serve it as it is.
 */
export function botFile(
  dataDir: string,
  bot: Pick<Bot, 'id' | 'groupId' | 'projectDir'>,
  threadId: string,
  rawPath: string,
  t: T,
): { full: string; size: number; served: boolean } {
  const paths = workspacePaths(dataDir, bot.id, threadId, bot.groupId);
  const cwd = bot.projectDir ?? paths.threadDir;
  const workspaces = real(resolve(dataDir, 'workspaces'))!;
  const served = [join(workspaces, 'bots', bot.id), ...(bot.groupId ? [real(paths.groupFiles!)!] : [])];
  const readable = [
    ...served,
    ...(bot.projectDir ? [real(bot.projectDir)].filter((p) => !!p) : []),
  ] as string[];

  if (!rawPath.trim()) throw new Error(t('files.emptyPath'));
  const full = real(isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath));
  if (!full || !readable.some((r) => inside(full, r))) throw new Error(t('files.outside', { path: rawPath }));
  const st = statSync(full);
  if (!st.isFile()) throw new Error(t('files.notAFile'));
  return { full, size: st.size, served: served.some((r) => inside(full, r)) };
}

/**
 * Where a file the bot sends must be, and where the person can download it from. The library
 * serves the bot's own folder and its group's; a file elsewhere (its project folder) is copied
 * into the conversation folder first.
 */
export async function shareableFile(
  dataDir: string,
  bot: Pick<Bot, 'id' | 'groupId' | 'projectDir'>,
  threadId: string,
  rawPath: string,
  t: T,
): Promise<MessageFile> {
  const paths = workspacePaths(dataDir, bot.id, threadId, bot.groupId);
  const workspaces = real(resolve(dataDir, 'workspaces'))!;
  const { full, size, served } = botFile(dataDir, bot, threadId, rawPath, t);

  let file = full;
  if (!served) {
    // From the project folder: a copy in the conversation folder, under a free name.
    const base = safeFileName(basename(full));
    for (let n = 1; ; n++) {
      const name = n === 1 ? base : base.replace(/(\.[^.]*)?$/, ` (${n})$1`);
      const target = join(real(paths.threadDir)!, name);
      try {
        // A copy, not a link: later edits to the project file must not change what was sent.
        await copyFile(full, target, constants.COPYFILE_EXCL);
        file = target;
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || n >= 1000) throw err;
      }
    }
  }
  return { name: basename(file), size, path: relative(workspaces, file) };
}

/** `send_file`: hands a file from the bot's folders to the person, as a card in the conversation. */
export function sendFileTool(opts: {
  def: Define;
  services: Services;
  dataDir: string;
  bot: Bot;
  threadId: string;
  t: T;
}): AppTool {
  const { def, services, dataDir, bot, threadId, t } = opts;
  return def(
    'send_file',
    {
      paths: z.array(z.string().max(2000)).min(1).max(10),
      caption: z.string().max(2000).optional(),
    },
    async ({ paths, caption }) => {
      const files: MessageFile[] = [];
      for (const p of paths) files.push(await shareableFile(dataDir, bot, threadId, p, t));
      await services.threads.addMessage({
        threadId,
        role: 'assistant',
        author: `bot:${bot.id}`,
        text: caption?.trim() ?? '',
        // No turn id: the streaming reply of the same turn stays on screen until it is saved.
        props: { files },
      });
      return t('tool.fileSent', { names: files.map((f) => f.name).join(', ') });
    },
    'internal',
  );
}

/** A folder in the bot's folders, by the same rules as its files. */
function botFolder(
  dataDir: string,
  bot: Pick<Bot, 'id' | 'groupId' | 'projectDir'>,
  threadId: string,
  rawPath: string,
) {
  const paths = workspacePaths(dataDir, bot.id, threadId, bot.groupId);
  const full = real(isAbsolute(rawPath) ? rawPath : resolve(bot.projectDir ?? paths.threadDir, rawPath));
  if (!full || !statSync(full).isDirectory()) throw new Error('not a folder');
  const workspaces = real(resolve(dataDir, 'workspaces'))!;
  const roots = [join(workspaces, 'bots', bot.id), ...(bot.groupId ? [real(paths.groupFiles!)!] : [])];
  if (!roots.some((r) => inside(full, r))) throw new Error('outside');
  return { full };
}

/** The largest page a bot may show in the conversation. */
const MAX_PAGE = 2 * 1024 * 1024;

/**
 * `show_page`: shows an HTML page the bot made (a chart, a map, a small tool) in the conversation,
 * running in an isolated frame: its scripts run, but it cannot reach the app, its data or the
 * network beyond the libraries it loads. The card always shows the file as it is now, so the bot
 * updates a page by writing the file again and showing it once more.
 */
export function showPageTool(opts: {
  def: Define;
  services: Services;
  dataDir: string;
  bot: Bot;
  threadId: string;
  t: T;
}): AppTool {
  const { def, services, dataDir, bot, threadId, t } = opts;
  return def(
    'show_page',
    {
      path: z.string().max(2000),
      title: z.string().max(120).optional(),
      height: z.number().int().min(200).max(1200).optional(),
    },
    async ({ path, title, height }) => {
      // A folder shows its index.html, with the scripts, styles, pictures and data beside it.
      let page = path;
      try {
        const { full } = botFolder(dataDir, bot, threadId, path);
        page = join(full, 'index.html');
      } catch {
        // Not a folder: a page file.
      }
      if (!/\.html?$/i.test(page)) return t('tool.pageNotHtml');
      const file = await shareableFile(dataDir, bot, threadId, page, t);
      if (file.size > MAX_PAGE) return t('tool.pageTooLarge');
      const { leftOut } = await bundlePage(botFile(dataDir, bot, threadId, page, t).full);
      await services.threads.addMessage({
        threadId,
        role: 'assistant',
        author: `bot:${bot.id}`,
        text: title?.trim() ?? '',
        props: { page: { path: file.path, name: file.name, ...(height && { height }) } },
      });
      const shown = t('tool.pageShown', { name: file.name });
      if (!leftOut.length) return shown;
      const names = leftOut.slice(0, 10).map((l) => `${l.name} (${t(`tool.pageLeftOut.${l.why}`)})`);
      return `${shown} ${t('tool.pageLeftOut', { files: names.join(', ') })}`;
    },
    'internal',
  );
}
