import { desktop } from './desktop';

/** The address that opens one conversation on this server: `…?thread=<id>`. */
export function threadLink(threadId: string, at: Pick<Location, 'origin' | 'pathname'> = location): string {
  // In the desktop app a page address would open in the browser; its own link opens the app.
  if (desktop?.takeLink) return `leafbot://thread/${encodeURIComponent(threadId)}`;
  return `${at.origin}${at.pathname}?thread=${encodeURIComponent(threadId)}`;
}

/** The conversation an opened link names, or null; read from a page address's query. */
export function linkedThread(search: string): string | null {
  const id = new URLSearchParams(search).get('thread');
  return id && /^[\w-]{1,64}$/.test(id) ? id : null;
}

/**
 * Takes the linked conversation from this page's address once, and drops it from the address so
 * a reload opens what the person moved on to. The link survives the sign-in page, which keeps it.
 */
export function takeLinkedThread(): string | null {
  const id = linkedThread(location.search);
  if (id) {
    const url = new URL(location.href);
    url.searchParams.delete('thread');
    history.replaceState(history.state, '', url);
  }
  return id;
}

/** The conversation a link in a message opens on this same server, or null for any other link. */
export function sameServerThread(
  href: string,
  at: Pick<Location, 'origin' | 'pathname' | 'href'> = location,
): string | null {
  // The desktop app's own link to a conversation, pasted into a chat.
  const app = /^(?:leafbot|yumakbot):\/\/thread\/([\w-]{1,64})\/?$/.exec(href);
  if (app) return app[1]!;
  try {
    const url = new URL(href, at.href);
    if (url.origin !== at.origin || url.pathname !== at.pathname) return null;
    return linkedThread(url.search);
  } catch {
    return null;
  }
}
