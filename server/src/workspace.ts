import { mkdirSync, realpathSync } from 'node:fs';
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
