import { lookup } from 'node:dns/promises';
import type { IncomingMessage } from 'node:http';
import { get as httpsGet } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { blockedAddress } from '@yumakbot/shared/egress';
import { HttpError } from '../util';
import { BodyTooLarge, readCapped } from './read-capped';

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

/**
 * Whether an address belongs to this machine or a private network, which a link must not reach.
 * One list for every check on this server, so a range added for one (an IPv6 form that carries a
 * private IPv4 address inside, a reserved block) is closed for all of them.
 */
export function privateAddress(ip: string): boolean {
  return blockedAddress(ip);
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

/**
 * Whether an address points at this machine or a private network: by name, by number, or by
 * what its name resolves to now. A name that resolves to nothing reaches nothing yet.
 */
export async function privateHost(raw: string): Promise<boolean> {
  const host = raw.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return true;
  if (isIP(host)) return privateAddress(host);
  const addresses = await lookup(host, { all: true }).catch(() => []);
  return addresses.some((a) => privateAddress(a.address));
}

/** A name that resolved to an address on this machine or a private network. */
class PrivateTarget extends Error {}

type Resolve = (host: string) => Promise<{ address: string; family?: number }[]>;

/**
 * The name lookup a connection uses: every address the name has is checked, and the connection is
 * handed only those, so it cannot go to an address that was not looked at. A name with any private
 * address is refused whole, since which address gets used is not ours to choose.
 */
export function publicLookup(resolve: Resolve = (h) => lookup(h, { all: true })): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (found) => {
        if (!found.length)
          return callback(Object.assign(new Error(`cannot resolve ${hostname}`), { code: 'ENOTFOUND' }), '');
        if (found.some((a) => privateAddress(a.address))) return callback(new PrivateTarget(hostname), '');
        const all = found.map((a) => ({ address: a.address, family: a.family ?? isIP(a.address) }));
        if (options.all) return callback(null, all);
        callback(null, all[0]!.address, all[0]!.family);
      },
      (err: Error) => callback(err, ''),
    );
  };
}

export interface PublicFetchOptions {
  /** Tests pass a stand-in for the name lookup. */
  resolve?: Resolve;
  timeoutMs?: number;
}

/** The text an https address serves, refusing private addresses, redirects and files over `max`. */
export async function fetchPublicText(
  url: URL,
  max = SKILL_LINK_MAX,
  o: PublicFetchOptions = {},
): Promise<string> {
  if (url.protocol !== 'https:') throw new HttpError(400, 'error.skillLinkHttps');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || (isIP(host) && privateAddress(host))) {
    throw new HttpError(400, 'error.skillLinkPrivate');
  }
  const unreachable = () => new HttpError(400, 'error.skillLinkUnreachable');
  const signal = AbortSignal.timeout(o.timeoutMs ?? 15_000);
  const res = await new Promise<IncomingMessage>((resolve, reject) => {
    const req = httpsGet(
      url,
      { lookup: publicLookup(o.resolve), signal, headers: { accept: '*/*', 'user-agent': 'node' } },
      resolve,
    );
    req.on('error', (err) =>
      reject(err instanceof PrivateTarget ? new HttpError(400, 'error.skillLinkPrivate') : unreachable()),
    );
  });
  const status = res.statusCode ?? 0;
  // A redirect could lead anywhere, a private address too: it is refused, not followed.
  if (status >= 300 && status < 400) {
    res.destroy();
    throw unreachable();
  }
  if (status < 200 || status >= 300) {
    res.destroy();
    throw new HttpError(400, 'error.skillLinkStatus', { status: String(status) });
  }
  if (Number(res.headers['content-length'] ?? 0) > max) {
    res.destroy();
    throw new HttpError(413, 'error.skillLinkTooLarge');
  }
  try {
    return (await readCapped(res, max)).toString('utf8');
  } catch (err) {
    if (err instanceof BodyTooLarge) throw new HttpError(413, 'error.skillLinkTooLarge');
    throw unreachable();
  }
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
