import { mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import type { Sandbox } from './engine/types';
import type { ServerKey } from './i18n';

export interface WorkspacePaths {
  botFiles: string;
  threadDir: string;
  groupFiles: string | null;
}

/**
 * Folder layout under `<dataDir>/workspaces`:
 *   bots/<botId>/files              bot's permanent folder (only that bot)
 *   bots/<botId>/threads/<threadId> thread work folder, default cwd (only that bot)
 *   groups/<groupId>/files          shared by the bots in the group
 */
export function workspacePaths(dataDir: string, botId: string, threadId: string, groupId: string | null) {
  const root = resolve(dataDir, 'workspaces');
  const paths: WorkspacePaths = {
    botFiles: join(root, 'bots', botId, 'files'),
    threadDir: join(root, 'bots', botId, 'threads', threadId),
    groupFiles: groupId ? join(root, 'groups', groupId, 'files') : null,
  };
  for (const p of [paths.botFiles, paths.threadDir, paths.groupFiles]) {
    if (p) mkdirSync(p, { recursive: true, mode: 0o700 });
  }
  return paths;
}

export function sandboxFor(
  paths: WorkspacePaths,
  opts: { projectDir: string | null; internet: boolean; readOnly: boolean },
): Sandbox {
  const cwd = opts.projectDir ?? paths.threadDir;
  const extra = [paths.botFiles, ...(paths.groupFiles ? [paths.groupFiles] : [])];
  if (opts.projectDir) extra.push(paths.threadDir);
  return {
    cwd,
    additionalDirectories: extra,
    writable: opts.readOnly ? [] : [cwd, ...extra],
    internet: opts.internet,
    readOnly: opts.readOnly,
  };
}

/**
 * A path as the system sees it: absolute, with links followed. When it does not exist yet, the
 * deepest folder above it that does is resolved and the rest kept as written, so it compares
 * equal to that folder's own resolved form (on macOS `/var` and `/home` are themselves links).
 */
export function realPath(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    return parent === abs ? abs : join(realPath(parent), basename(abs));
  }
}

/**
 * The file a link in a conversation points at, or null when there is none. The app reads a name a
 * bot writes in a message from the conversation's folder (`bots/<bot>/threads/<thread>/<rest>`),
 * but bots also name files of their persistent folder and their group's folder that way, by their
 * path in that folder or by their name alone: when the conversation's folder has no such file,
 * those are looked in too. A name alone is also looked for in their subfolders, the newest copy
 * winning. The caller still checks that the file is one the person may open.
 */
export function findLinkedFile(
  root: string,
  path: string,
  bot: { id: string; groupId: string | null },
): string | null {
  const direct = resolve(root, path);
  if (isFile(direct)) return direct;
  const parts = path.split('/');
  if (parts[0] !== 'bots' || parts[1] !== bot.id || parts[2] !== 'threads' || parts.length < 5) return null;
  const rest = parts.slice(4).join('/');
  const thread = join(root, 'bots', bot.id, 'threads', parts[3]!);
  const kept = [
    join(root, 'bots', bot.id, 'files'),
    ...(bot.groupId ? [join(root, 'groups', bot.groupId, 'files')] : []),
  ];
  for (const dir of kept) {
    const full = resolve(dir, rest);
    if (within(full, dir) && isFile(full)) return full;
  }
  if (rest.includes('/')) return null;
  for (const dir of [thread, ...kept]) {
    const found = newestNamed(dir, rest);
    if (found) return found;
  }
  return null;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The most recently changed file called `name` in `dir` or its subfolders; links are not followed. */
function newestNamed(dir: string, name: string): string | null {
  const found: { path: string; at: number }[] = [];
  let seen = 0;
  const walk = (at: string, depth: number) => {
    if (depth > 6 || seen > 5000) return;
    let entries;
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      seen++;
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
      const full = join(at, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && e.name === name) found.push({ path: full, at: statSync(full).mtimeMs });
    }
  };
  walk(dir, 0);
  return found.sort((a, b) => b.at - a.at)[0]?.path ?? null;
}

/** Whether `dir` is `base` or a folder inside it. */
function within(dir: string, base: string): boolean {
  const rel = relative(base, dir);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Why a folder cannot be a bot's project folder, or null when it can. The bot reads and writes
 * all of it, so it may not be the root, the home folder or any folder holding either, nor the
 * server's data folder (keys, other bots' files) or anything around or inside it.
 */
export function projectDirProblem(dir: string, opts: { home: string; dataDir: string }): ServerKey | null {
  if (!isAbsolute(dir)) return 'error.projectDirRelative';
  const target = realPath(dir);
  const home = realPath(opts.home);
  const data = realPath(opts.dataDir);
  if (target === parse(target).root || within(home, target)) return 'error.projectDirTooWide';
  if (within(data, target) || within(target, data)) return 'error.projectDirData';
  // Keys, tokens and sign-ins live in these: a bot given one could read or rewrite them.
  if (PRIVATE_DIRS.some((d) => within(target, join(home, d)) || within(join(home, d), target)))
    return 'error.projectDirPrivate';
  return null;
}

/** Folders of the home that hold credentials, other tools' sign-ins and settings. */
const PRIVATE_DIRS = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.docker',
  '.config',
  '.local',
  '.npm',
  '.azure',
  '.claude',
  '.codex',
  '.gemini',
  'Library',
  'AppData',
];
