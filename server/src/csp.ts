import { createHash } from 'node:crypto';

/** `script-src` sources for the page's inline scripts (the theme set before first paint). */
export function inlineScriptHashes(html: string): string[] {
  return [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(
    (m) => `'sha256-${createHash('sha256').update(m[1]!).digest('base64')}'`,
  );
}

/**
 * The web app's Content-Security-Policy. The page loads code, images and connections only from this
 * server: a reply or file the page shows cannot run a script or reach another address by itself.
 * Images also come from `data:` (avatars) and `blob:` (screens and file previews).
 */
export function appPolicy(html: string): string {
  return [
    "default-src 'self'",
    ["script-src 'self'", ...inlineScriptHashes(html)].join(' '),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** For the small pages the server writes itself: their own styles and nothing else. */
export const PLAIN_PAGE_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * Sent when the server is reached over HTTPS (secure cookies on): a browser that has seen it once goes
 * straight to HTTPS afterwards, so a network in the middle cannot hold it on plain HTTP and read the
 * session cookie. Browsers ignore it on plain HTTP, so the loopback health checks are not affected.
 */
export const STRICT_TRANSPORT_SECURITY = 'max-age=31536000';
