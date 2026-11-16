/**
 * Links that open a chat in the desktop app from outside it: a bookmark, a dashboard, a script.
 *
 * - `yumakbot://thread/<id>`: one conversation (a bot's or a room's)
 * - `yumakbot://bot/<id>`: a bot's chat, as clicking it in the sidebar opens it
 * - `yumakbot://room/<id>`: a room
 *
 * Opening one only shows that chat: it never sends anything or starts a conversation.
 */
export const LINK_SCHEME = 'yumakbot';

export interface AppLink {
  kind: 'thread' | 'bot' | 'room';
  id: string;
}

const KINDS = new Set<AppLink['kind']>(['thread', 'bot', 'room']);

/** The chat a link names, or null for anything else. */
export function parseLink(raw: string): AppLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${LINK_SCHEME}:`) return null;
  // `yumakbot://thread/x` reads as host "thread" and path "/x"; `yumakbot:thread/x` as a path alone.
  const parts = [url.host, ...url.pathname.split('/')].filter(Boolean).map((p) => decodeURIComponent(p));
  const [kind, id, ...rest] = parts;
  if (!kind || !id || rest.length || !KINDS.has(kind as AppLink['kind'])) return null;
  if (!/^[\w-]{1,64}$/.test(id)) return null;
  return { kind: kind as AppLink['kind'], id };
}

/** The link among a started app's arguments (Windows and Linux pass it there), if any. */
export function linkInArgs(argv: readonly string[]): AppLink | null {
  for (const a of argv) {
    if (a.startsWith(`${LINK_SCHEME}:`)) {
      const link = parseLink(a);
      if (link) return link;
    }
  }
  return null;
}
