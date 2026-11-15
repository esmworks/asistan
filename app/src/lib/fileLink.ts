import { createContext } from 'react';

/** Where links to files in a conversation point: the bot's files, from its thread folder. */
export const FileLinks = createContext<{ botId: string; base: string } | null>(null);

/**
 * The bot-folder path a link in a message names, or null for a web address and anything else
 * that is not a file. Takes `file://` links, absolute paths, and paths relative to the thread's
 * folder (`base`); a `:12` line number or a `#part` is dropped.
 */
export function localFilePath(href: string, base: string): string | null {
  let raw = href.trim();
  if (/^file:\/\//i.test(raw)) raw = raw.replace(/^file:\/\//i, '');
  else if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//') || raw.startsWith('#')) return null;
  raw = raw.replace(/[?#].*$/, '').replace(/:\d+(:\d+)?$/, '');
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // Kept as written.
  }
  if (!raw || raw.startsWith('~') || raw.endsWith('/')) return null;
  const segments = (raw.startsWith('/') ? raw : `${base}/${raw}`).split('/');
  const out: string[] = [];
  for (const s of segments) {
    if (s === '' || s === '.') continue;
    if (s === '..') out.pop();
    else out.push(s);
  }
  if (!out.length) return null;
  return raw.startsWith('/') ? `/${out.join('/')}` : out.join('/');
}

/** The bot-folder path of a link to a folder (`reports/`), or null when the link is not one. */
export function localFolderPath(href: string, base: string): string | null {
  const raw = href.trim();
  if (!raw.endsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  return localFilePath(raw.replace(/\/+$/, ''), base);
}

/**
 * A folder path in the form the bot's file list uses (relative to the workspaces folder): a
 * relative one as is, an absolute one from its bots/ or groups/ part on.
 */
export function libraryKey(path: string): string {
  if (!path.startsWith('/')) return path;
  const at = path.search(/\/(bots|groups)\//);
  return at >= 0 ? path.slice(at + 1) : path.slice(1);
}
