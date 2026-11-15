import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { HttpError } from '../util';

/** The largest skill file a link may bring in. */
export const SKILL_LINK_MAX = 256 * 1024;

/**
 * The address that serves a skill file's text for a link a person pastes: a GitHub page of a file
 * becomes its raw address, and a repository or folder page points at the SKILL.md in it.
 */
export function skillFileUrl(input: string): URL {
  const url = new URL(input.trim());
  if (url.protocol !== 'https:') throw new HttpError(400, 'error.skillLinkHttps');
  if (url.hostname === 'github.com') {
    const [owner, repo, kind, ref, ...rest] = url.pathname.split('/').filter(Boolean);
    if (owner && repo) {
      const path = rest.join('/');
      if (kind === 'blob' && ref)
        return new URL(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`);
      if (kind === 'tree' && ref)
        return new URL(
          `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path ? `${path}/` : ''}SKILL.md`,
        );
      if (!kind) return new URL(`https://raw.githubusercontent.com/${owner}/${repo}/HEAD/SKILL.md`);
    }
  }
  return url;
}

/** Whether an address belongs to this machine or a private network, which a link must not reach. */
export function privateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (v === 6) {
    const low = ip.toLowerCase();
    if (low.startsWith('::ffff:')) return privateAddress(low.slice(7));
    return (
      low === '::1' || low === '::' || low.startsWith('fc') || low.startsWith('fd') || low.startsWith('fe80')
    );
  }
  return true;
}

/** Whether a host name or address is on the public internet: not this machine or a private network. */
export async function publicHost(raw: string): Promise<boolean> {
  const host = raw.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return false;
  if (isIP(host)) return !privateAddress(host);
  // A name that does not resolve here reaches nothing, so it is refused as well.
  const addresses = await lookup(host, { all: true }).catch(() => []);
  return addresses.length > 0 && !addresses.some((a) => privateAddress(a.address));
}

/** The text an https address serves, refusing private addresses, redirects and files over `max`. */
export async function fetchPublicText(url: URL, max = SKILL_LINK_MAX): Promise<string> {
  if (url.protocol !== 'https:') throw new HttpError(400, 'error.skillLinkHttps');
  const { address } = await lookup(url.hostname).catch(() => {
    throw new HttpError(400, 'error.skillLinkUnreachable');
  });
  if (privateAddress(address)) throw new HttpError(400, 'error.skillLinkPrivate');
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) }).catch(() => {
    throw new HttpError(400, 'error.skillLinkUnreachable');
  });
  if (!res.ok) throw new HttpError(400, 'error.skillLinkStatus', { status: String(res.status) });
  const size = Number(res.headers.get('content-length') ?? 0);
  if (size > max) throw new HttpError(413, 'error.skillLinkTooLarge');
  const text = await res.text();
  if (text.length > max) throw new HttpError(413, 'error.skillLinkTooLarge');
  return text;
}

/** The text of the skill file a link names; refuses private addresses, other schemes and big files. */
export async function fetchSkillFile(input: string): Promise<{ text: string; name: string }> {
  let url: URL;
  try {
    url = skillFileUrl(input);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'error.skillLinkInvalid');
  }
  const text = await fetchPublicText(url);
  const file = decodeURIComponent(url.pathname.split('/').pop() ?? '');
  return { text, name: file === 'SKILL.md' ? '' : file };
}
