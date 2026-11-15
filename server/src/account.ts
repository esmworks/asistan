import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema, type Db } from './db';

const KEY = 'account';
/** Shortest password accepted; the account stands in for a 256-bit access key. */
export const MIN_PASSWORD = 8;
/** Failed sign-ins one address may make in a window before it has to wait the window out. */
export const MAX_FAILURES = 10;
export const FAILURE_WINDOW_MS = 15 * 60_000;

const PARAMS = { N: 16384, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;

interface Stored {
  username: string;
  salt: string;
  hash: string;
  N: number;
  r: number;
  p: number;
}

function derive(password: string, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, opts, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The person's own sign-in: one username and password, so the long access key is typed once,
 * when the account is made. Only a scrypt hash of the password is kept.
 */
export class Account {
  constructor(private db: Db) {}

  private async stored(): Promise<Stored | null> {
    const [row] = await this.db.select().from(schema.kv).where(eq(schema.kv.key, KEY)).limit(1);
    const v = row?.value as Partial<Stored> | undefined;
    return v?.username && v.salt && v.hash ? (v as Stored) : null;
  }

  async username(): Promise<string | null> {
    return (await this.stored())?.username ?? null;
  }

  async set(username: string, password: string): Promise<void> {
    const salt = randomBytes(16);
    const hash = await derive(password, salt, PARAMS);
    const value: Stored = {
      username: username.trim(),
      salt: salt.toString('base64'),
      hash: hash.toString('base64'),
      ...PARAMS,
    };
    await this.db
      .insert(schema.kv)
      .values({ key: KEY, value })
      .onConflictDoUpdate({ target: schema.kv.key, set: { value } });
  }

  /** Whether the password is the account's; with a username, that it names the account too. */
  async check(password: string, username?: string): Promise<boolean> {
    const s = await this.stored();
    // Without an account the work is still done, so a reply's timing does not tell whether one exists.
    const salt = s ? Buffer.from(s.salt, 'base64') : randomBytes(16);
    const derived = await derive(password, salt, s ? { N: s.N, r: s.r, p: s.p } : PARAMS);
    if (!s) return false;
    const expected = Buffer.from(s.hash, 'base64');
    const ok = expected.length === derived.length && timingSafeEqual(expected, derived);
    return ok && (username === undefined || sameName(username, s.username));
  }
}

/** Counts failed sign-ins per address; one with too many waits until the oldest leaves the window. */
export class LoginThrottle {
  private failures = new Map<string, number[]>();
  constructor(private now: () => number = Date.now) {}

  private recent(who: string): number[] {
    const since = this.now() - FAILURE_WINDOW_MS;
    const list = (this.failures.get(who) ?? []).filter((at) => at > since);
    if (list.length) this.failures.set(who, list);
    else this.failures.delete(who);
    return list;
  }

  blocked(who: string): boolean {
    return this.recent(who).length >= MAX_FAILURES;
  }

  failed(who: string) {
    // Many addresses each failing once must not grow the map for ever.
    if (this.failures.size > 5000) for (const k of [...this.failures.keys()]) this.recent(k);
    this.failures.set(who, [...this.recent(who), this.now()]);
  }

  succeeded(who: string) {
    this.failures.delete(who);
  }
}
