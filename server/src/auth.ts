import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Params, SessionInfo } from '@yumakbot/shared';
import { desc, eq } from 'drizzle-orm';
import type { Config } from './config';
import { schema, type Db } from './db';
import { Account, LoginThrottle } from './account';
import type { ServerKey } from './i18n';
import { HttpError } from './util';

export const SESSION_COOKIE = 'yumakbot_session';
/** A session unused for this long ends; every use moves the end further away. */
export const SESSION_IDLE_MS = 90 * 24 * 60 * 60_000;
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** Access key from the environment, or a 0600 file in the data dir (created on first run). */
export function loadAccessKey(config: Config): string {
  if (config.accessKey) return config.accessKey;
  const file = join(config.dataDir, 'access-key');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const key = randomBytes(32).toString('base64url');
  writeFileSync(file, `${key}\n`, { mode: 0o600 });
  return key;
}

export function sameSecret(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export const hashSession = (token: string) => createHash('sha256').update(token).digest('hex');

function hostName(host: string): string {
  // Strip port; keep IPv6 brackets.
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1);
  return host.split(':')[0] ?? host;
}

export interface RequestMeta {
  host: string | undefined;
  origin: string | undefined;
  method: string;
}

/**
 * Host and Origin checks against DNS rebinding and cross-site requests.
 * Returns the error to send (403), or null if the request may proceed.
 */
export function checkHostOrigin(meta: RequestMeta, config: Config): HttpError | null {
  const refuse = (key: ServerKey, params?: Params) => new HttpError(403, key, params);
  const host = meta.host?.toLowerCase();
  if (!host) return refuse('error.hostMissing');
  // The public address's host is one the server is reached at by definition.
  const publicHost = config.publicUrl ? [new URL(config.publicUrl).host.toLowerCase()] : [];
  const allowedHosts = new Set([
    ...LOOPBACK_HOSTS,
    ...config.allowedHosts.map((h) => h.toLowerCase()),
    ...publicHost,
  ]);
  if (!allowedHosts.has(hostName(host)) && !allowedHosts.has(host))
    return refuse('error.hostNotAllowed', { host });
  const origin = meta.origin;
  if (origin === undefined) return null;
  if (origin === 'null') return refuse('error.originNull');
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return refuse('error.originInvalid');
  }
  if (url.host.toLowerCase() === host) return null;
  if (config.allowedOrigins.includes(url.origin)) return null;
  return refuse('error.originNotAllowed', { origin });
}

export class Auth {
  private cache = new Map<string, number>();
  readonly account: Account;
  readonly throttle = new LoginThrottle();
  constructor(
    private db: Db,
    private key: string,
  ) {
    this.account = new Account(db);
  }

  checkKey(candidate: string): boolean {
    return sameSecret(candidate, this.key);
  }

  async createSession(userAgent?: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.db
      .insert(schema.sessions)
      .values({ id: hashSession(token), userAgent: userAgent ? userAgent.slice(0, 300) : null });
    return token;
  }

  /**
   * Whether the token belongs to a live session. A session is kept alive by use: one unused for
   * longer than SESSION_IDLE_MS ends, so a device left behind does not stay signed in for ever.
   */
  async validSession(token: string | undefined, now = new Date()): Promise<boolean> {
    if (!token) return false;
    const id = hashSession(token);
    const seen = this.cache.get(id);
    if (seen && now.getTime() - seen < 60_000) return true;
    const [row] = await this.db.select().from(schema.sessions).where(eq(schema.sessions.id, id)).limit(1);
    if (!row) return false;
    if (now.getTime() - row.lastSeenAt.getTime() > SESSION_IDLE_MS) {
      await this.db.delete(schema.sessions).where(eq(schema.sessions.id, id));
      return false;
    }
    this.cache.set(id, now.getTime());
    await this.db.update(schema.sessions).set({ lastSeenAt: now }).where(eq(schema.sessions.id, id));
    return true;
  }

  /** Every signed-in device, the one asking marked, most recently used first. */
  async listSessions(current: string | undefined): Promise<SessionInfo[]> {
    const mine = current ? hashSession(current) : null;
    const rows = await this.db.select().from(schema.sessions).orderBy(desc(schema.sessions.lastSeenAt));
    const live = rows.filter((r) => Date.now() - r.lastSeenAt.getTime() <= SESSION_IDLE_MS);
    return live.map((r) => ({
      // A short public name: the stored id is a hash, but it is still what a token is checked against.
      id: r.id.slice(0, 16),
      userAgent: r.userAgent,
      createdAt: r.createdAt.toISOString(),
      lastSeenAt: r.lastSeenAt.toISOString(),
      current: r.id === mine,
    }));
  }

  /** Signs out the device named by `id` (from listSessions), or every other one with `others`. */
  async revokeSessions(current: string | undefined, target: { id: string } | 'others'): Promise<number> {
    const mine = current ? hashSession(current) : null;
    const rows = await this.db.select({ id: schema.sessions.id }).from(schema.sessions);
    const gone = rows
      .map((r) => r.id)
      .filter((id) => id !== mine && (target === 'others' || id.slice(0, 16) === target.id));
    for (const id of gone) {
      this.cache.delete(id);
      await this.db.delete(schema.sessions).where(eq(schema.sessions.id, id));
    }
    return gone.length;
  }

  async endSession(token: string | undefined) {
    if (!token) return;
    const id = hashSession(token);
    this.cache.delete(id);
    await this.db.delete(schema.sessions).where(eq(schema.sessions.id, id));
  }

  /** Bearer key or session cookie. */
  async authenticate(headers: { authorization?: string | undefined }, cookie: string | undefined) {
    const auth = headers.authorization;
    if (auth?.startsWith('Bearer ')) return this.checkKey(auth.slice(7).trim()) ? 'bearer' : null;
    return (await this.validSession(cookie)) ? 'cookie' : null;
  }
}

export function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}
