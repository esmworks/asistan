import { constants, lstatSync, mkdirSync } from 'node:fs';
import { copyFile, link, open, readdir, rm, rmdir, stat, unlink } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { FileName, MAX_UPLOAD_BYTES } from '@yumakbot/shared';
import type { T } from './i18n';
import { HttpError } from './util';

/**
 * Uploads wait outside the bots' folders until their message is sent: a file the person takes
 * back, or leaves behind by closing the page, is never seen by the bot or listed in the library.
 */
export function stagingDir(dataDir: string, threadId: string): string {
  const dir = join(dataDir, 'uploads', threadId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** How long an upload may wait for its message before the sweep removes it. */
export const STAGED_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Turns a name from the person's computer into one plain file name: no folders, no control
 * characters, no leading dots (hidden files are left out of the library), at most 120 characters.
 */
export function safeFileName(raw: string): string {
  const last = raw.split(/[/\\]/).pop() ?? '';
  let name = last
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .replace(/^\.+/, '');
  if (name.length > 120) {
    const ext = extname(name).slice(0, 20);
    name = name.slice(0, 120 - ext.length) + ext;
  }
  return name || 'file';
}

/** `rapor.pdf`, `rapor (2).pdf`, `rapor (3).pdf`, … */
function numbered(name: string, n: number) {
  if (n === 1) return name;
  const ext = extname(name);
  return `${name.slice(0, name.length - ext.length)} (${n})${ext}`;
}

/**
 * Writes an upload into `dir` under a free name; an existing file is never replaced and a link
 * is never followed. A body over the limit is cut off and the partial file removed.
 */
export async function saveUpload(
  dir: string,
  rawName: string,
  body: Readable,
  max = MAX_UPLOAD_BYTES,
): Promise<{ name: string; size: number }> {
  const base = safeFileName(rawName);
  let fh;
  let name = base;
  for (let n = 1; !fh; n++) {
    name = numbered(base, n);
    try {
      fh = await open(
        join(dir, name),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o644,
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || n >= 1000) throw err;
    }
  }
  let size = 0;
  try {
    for await (const chunk of body) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > max) throw new HttpError(413, 'error.fileTooLarge', { max: Math.round(max / 1024 / 1024) });
      await fh.write(buf);
    }
    await fh.close();
  } catch (err) {
    await fh.close().catch(() => {});
    await rm(join(dir, name), { force: true });
    body.resume();
    throw err;
  }
  return { name, size };
}

/** The attached files as they are in `dir`: each must be a plain file there (not a link). */
export function attachedFiles(dir: string, names: string[]): { name: string; size: number }[] {
  return [...new Set(names)].map((name) => {
    if (!FileName.safeParse(name).success) throw new HttpError(400, 'validation.fileName');
    let st;
    try {
      st = lstatSync(join(dir, name));
    } catch {
      throw new HttpError(404, 'error.fileMissing');
    }
    if (!st.isFile()) throw new HttpError(404, 'error.fileMissing');
    return { name, size: st.size };
  });
}

/** The prompt the bot gets: the person's text, then where the attached files are. */
/** The person's message with the bot message it answers quoted above it. */
export function promptWithReply(text: string, quoted: string | undefined, t: T): string {
  if (quoted === undefined) return text;
  const lines = quoted.split('\n').map((l) => `> ${l}`);
  return `${t('prompt.replyTo')}\n${lines.join('\n')}\n\n${text}`;
}

/** What the bot is told when the person leaves an emoji on one of its messages. */
export function reactionPrompt(emoji: string, quoted: string, t: T, silent: string): string {
  const lines = quoted.split('\n').map((l) => `> ${l}`);
  return `${t('prompt.reaction', { emoji })}\n${lines.join('\n')}\n\n${t('prompt.reactionHint', { silent })}`;
}

export function promptWithFiles(text: string, dir: string, files: { name: string }[], t: T): string {
  if (!files.length) return text;
  const list = [t('prompt.attached'), ...files.map((f) => `- ${join(dir, f.name)}`)].join('\n');
  return text ? `${text}\n\n${list}` : list;
}

/**
 * Moves sent files from the staging folder into the conversation folder. A file there with the
 * same name (the bot's own, say) is kept: the new one takes the next free name.
 */
export async function moveIntoThread(
  from: string,
  to: string,
  files: { name: string; size: number }[],
): Promise<{ name: string; size: number }[]> {
  const moved: { name: string; size: number }[] = [];
  for (const f of files) {
    const src = join(from, f.name);
    for (let n = 1; ; n++) {
      const name = numbered(f.name, n);
      try {
        // A hard link never replaces an existing file; across file systems, an exclusive copy.
        await link(src, join(to, name)).catch(async (err: NodeJS.ErrnoException) => {
          if (err.code !== 'EXDEV') throw err;
          await copyFile(src, join(to, name), constants.COPYFILE_EXCL);
        });
        await unlink(src);
        moved.push({ name, size: f.size });
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || n >= 1000) throw err;
      }
    }
  }
  return moved;
}

/** Removes uploads older than `maxAgeMs` whose message was never sent, and empty folders. */
export async function sweepUploads(dataDir: string, maxAgeMs = STAGED_MAX_AGE_MS, now = Date.now()) {
  const root = join(dataDir, 'uploads');
  let removed = 0;
  let threads: string[];
  try {
    threads = await readdir(root);
  } catch {
    return 0;
  }
  for (const thread of threads) {
    const dir = join(root, thread);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const file = join(dir, name);
      const st = await stat(file).catch(() => null);
      if (st && now - st.mtimeMs > maxAgeMs) {
        await rm(file, { force: true, recursive: true });
        removed++;
      }
    }
    // Only succeeds once the folder is empty.
    await rmdir(dir).catch(() => {});
  }
  return removed;
}
