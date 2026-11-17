import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema, type Db } from './db';

const KEY = 'account';
/** Shortest password accepted; the account stands in for a 256-bit access key. */
export const MIN_PASSWORD = 8;
/** Failed sign-ins one address may make in a window before it has to wait the window out. */
export const MAX_FAILURES = 10;
export const FAILURE_WINDOW_MS = 15 * 60_000;

/**
 * The cost of new hashes: 128 MiB and a fraction of a second per guess, so a copied database does
 * not give the password up quickly. Each hash keeps its own cost, so older, cheaper ones still
 * verify, and are made again at this cost on the next sign-in.
 */
export const PASSWORD_SCRYPT = { N: 2 ** 17, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
/** The most memory a stored cost may ask for; one beyond it is not a hash this server made. */
const MAX_SCRYPT_MEMORY = 1024 * 1024 * 1024;

interface Cost {
  N: number;
  r: number;
  p: number;
}

interface Stored extends Cost {
  username: string;
  salt: string;
  hash: string;
}

const sameCost = (a: Cost, b: Cost) => a.N === b.N && a.r === b.r && a.p === b.p;

const affordable = ({ N, r, p }: Cost) =>
  Number.isSafeInteger(N) &&
  N >= 1024 &&
  (N & (N - 1)) === 0 &&
  Number.isSafeInteger(r) &&
  r >= 1 &&
  Number.isSafeInteger(p) &&
  p >= 1 &&
  p <= 16 &&
  128 * N * r <= MAX_SCRYPT_MEMORY;

/**
 * Hashes running at once. Each holds 128 MiB, so a burst of sign-in attempts waits its turn
 * instead of taking the server's memory, and leaves Node's worker threads free for files.
 */
const MAX_DERIVING = 2;
let deriving = 0;
const waiting: (() => void)[] = [];

async function derive(password: string, salt: Buffer, cost: Cost): Promise<Buffer> {
  if (deriving < MAX_DERIVING) deriving++;
  else await new Promise<void>((r) => waiting.push(r));
  try {
    const opts: ScryptOptions = { ...cost, maxmem: 2 * 128 * cost.N * cost.r };
    return await new Promise<Buffer>((resolve, reject) =>
      scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, opts, (err, key) =>
        err ? reject(err) : resolve(key),
      ),
    );
  } finally {
    // The place passes straight to the next in line, so no newcomer slips in between.
    const next = waiting.shift();
    if (next) next();
    else deriving--;
  }
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
    const hash = await derive(password, salt, PASSWORD_SCRYPT);
    const value: Stored = {
      username: username.trim(),
      salt: salt.toString('base64'),
      hash: hash.toString('base64'),
      ...PASSWORD_SCRYPT,
    };
    await this.db
      .insert(schema.kv)
      .values({ key: KEY, value })
      .onConflictDoUpdate({ target: schema.kv.key, set: { value } });
  }

  /**
   * Whether the password is the account's; with a username, that it names the account too. A
   * hash made at an older, lower cost is made again at today's once the password is known right.
   */
  async check(password: string, username?: string): Promise<boolean> {
    const s = await this.stored();
    const cost: Cost | null = s ? { N: s.N, r: s.r, p: s.p } : null;
    // Without an account the work is still done, so a reply's timing does not tell whether one exists.
    const salt = s ? Buffer.from(s.salt, 'base64') : randomBytes(16);
    const derived = await derive(password, salt, cost && affordable(cost) ? cost : PASSWORD_SCRYPT);
    if (!s || !cost || !affordable(cost)) return false;
    const expected = Buffer.from(s.hash, 'base64');
    const ok =
      expected.length === derived.length &&
      timingSafeEqual(expected, derived) &&
      (username === undefined || sameName(username, s.username));
    // The sign-in stands even if the new hash cannot be written; it is tried again next time.
    if (ok && !sameCost(cost, PASSWORD_SCRYPT)) await this.set(s.username, password).catch(() => {});
    return ok;
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
