/**
 * The origins to try for what was typed as a server address: as written when it has a scheme,
 * otherwise https first and then http, since a self-hosted server on a home network is often
 * plain http. Anything that is not an http(s) address gives none.
 */
export function candidates(raw: string): string[] {
  const v = raw.trim();
  if (!v) return [];
  // The origin drops any path; a bare `http://` has no host and gives none.
  const list = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? [v] : [`https://${v}`, `http://${v}`];
  return list.flatMap((u) => {
    try {
      const url = new URL(u);
      return url.protocol === 'http:' || url.protocol === 'https:' ? [url.origin] : [];
    } catch {
      return [];
    }
  });
}

/** The host and port of an origin, for showing which server the app talks to. */
export function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}
