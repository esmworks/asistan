/**
 * The origins to try for what was typed as a server address: as written when it has a scheme,
 * otherwise https first and then, only for a server on this device, the local network or a private
 * VPN, plain http, since a self-hosted server at home is often plain http. A server on the internet
 * is only tried over https unless http:// is typed, and then `insecure` tells the app to ask first.
 * Anything that is not an http(s) address gives none.
 */
export function candidates(raw: string): string[] {
  const v = raw.trim();
  if (!v) return [];
  // The origin drops any path; a bare `http://` has no host and gives none.
  const typed = /^[a-z][a-z0-9+.-]*:\/\//i.test(v);
  const list = typed ? [v] : [`https://${v}`, `http://${v}`];
  return list.flatMap((u, i) => {
    try {
      const url = new URL(u);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return [];
      if (!typed && i > 0 && !isLocalHost(url.hostname)) return [];
      return [url.origin];
    } catch {
      return [];
    }
  });
}

/**
 * Whether talking to this origin sends the access key, the password and the conversations over the
 * internet unencrypted: plain http to a host that is not local.
 */
export function insecure(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && !isLocalHost(url.hostname);
  } catch {
    return false;
  }
}

/** Names that only resolve on the local network or inside a Tailscale tailnet. */
const LOCAL_SUFFIXES = ['.local', '.localhost', '.lan', '.home.arpa', '.internal', '.ts.net'];

/**
 * Whether a host name is this device, the local network or a Tailscale tailnet, where plain http
 * does not cross the internet (Tailscale encrypts the traffic between devices itself): loopback,
 * private, link-local and shared (100.64.0.0/10, Tailscale's) IPv4 addresses, the matching IPv6
 * ranges, single-label names and local-only suffixes.
 */
export function isLocalHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (!host) return false;
  const v4 = ipv4(host);
  if (v4) {
    const [a, b] = v4;
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (host.includes(':')) {
    // Loopback, unique local (fc00::/7) and link-local (fe80::/10).
    // The first group must have all four digits: `fc::1` is 00fc::1.
    return host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
  }
  if (host === 'localhost' || !host.includes('.')) return true;
  return LOCAL_SUFFIXES.some((s) => host.endsWith(s));
}

/** The first two numbers of a dotted IPv4 address, which is all the ranges above need. */
function ipv4(host: string): [number, number] | null {
  const parts = host.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return null;
  const n = parts.map(Number);
  return n.every((x) => x <= 255) ? [n[0]!, n[1]!] : null;
}

/** The host and port of an origin, for showing which server the app talks to. */
export function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}
