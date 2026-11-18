import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { isIPv6 } from 'node:net';
import type { PasswordHash } from './db/schema';

/** Shortest password accepted; the account stands in for a 256-bit access key. */
export const MIN_PASSWORD = 8;
/** Failed sign-ins one address may make in a window before it has to wait the window out. */
export const MAX_FAILURES = 10;
export const FAILURE_WINDOW_MS = 15 * 60_000;
/**
 * Failed sign-ins from all addresses together in a day before tries are spaced out. A day, not
 * the per-address window: over a short window the pauses would only ever reach a few seconds
 * before the failures left it again.
 */
export const GLOBAL_FREE_FAILURES = 100;
export const GLOBAL_WINDOW_MS = 24 * 60 * 60_000;
/**
 * The first pause between tries past that; it doubles every ten failures more, up to the most,
 * which holds a guesser with any number of addresses to a few hundred tries a day.
 */
export const GLOBAL_PAUSE_MS = 2_000;
export const GLOBAL_MAX_PAUSE_MS = 5 * 60_000;

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

/** Hashes a new password at today's cost. */
export async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, PASSWORD_SCRYPT);
  return { salt: salt.toString('base64'), hash: hash.toString('base64'), ...PASSWORD_SCRYPT };
}

/**
 * Whether the password matches a stored hash, and whether that hash was made at an older, lower
 * cost and should be made again. Without a stored hash the work is still done, so a reply's timing
 * does not tell whether there is one.
 */
export async function verifyPassword(
  password: string,
  stored: PasswordHash | null,
): Promise<{ ok: boolean; stale: boolean }> {
  const cost: Cost | null = stored ? { N: stored.N, r: stored.r, p: stored.p } : null;
  const salt = stored ? Buffer.from(stored.salt, 'base64') : randomBytes(16);
  const derived = await derive(password, salt, cost && affordable(cost) ? cost : PASSWORD_SCRYPT);
  if (!stored || !cost || !affordable(cost)) return { ok: false, stale: false };
  const expected = Buffer.from(stored.hash, 'base64');
  const ok = expected.length === derived.length && timingSafeEqual(expected, derived);
  return { ok, stale: ok && !sameCost(cost, PASSWORD_SCRYPT) };
}

/**
 * The address a sign-in limit counts against. An IPv6 user is usually handed a whole /64, so
 * every address in it counts as one; an IPv4 address written as IPv6 counts as itself.
 */
export function addressGroup(address: string): string {
  const a = (
    address
      .trim()
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .split('%')[0] ?? ''
  ).trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) return mapped[1]!;
  if (!isIPv6(a)) return a;
  // An embedded IPv4 address at the end stands for two groups.
  const width = (xs: string[]) => xs.reduce((n, x) => n + (x.includes('.') ? 2 : 1), 0);
  let groups = a.split(':');
  if (a.includes('::')) {
    const [head = '', tail = ''] = a.split('::');
    const hs = head ? head.split(':') : [];
    const ts = tail ? tail.split(':') : [];
    groups = [...hs, ...Array<string>(8 - width(hs) - width(ts)).fill('0'), ...ts];
  }
  return `${groups
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(':')}::/64`;
}

/** One sign-in try taken from the limit before the password is checked. */
export interface SignInTry {
  /** The try was right: the address starts over, and the try is handed back to the shared count. */
  succeeded(): void;
}

/**
 * Counts failed sign-ins. A try is counted when it starts, before the slow password check, so
 * tries sent all at once cannot slip past the limit together; a right one is handed back.
 *
 * Each address (an IPv6 /64) may fail MAX_FAILURES times in a window, then waits until the oldest
 * leaves it. All addresses together may fail GLOBAL_FREE_FAILURES times a day; past that,
 * tries are let through one at a time, with a pause that grows as failures go on, so changing
 * addresses does not buy unlimited guesses. That ceiling only slows guessing: the access key,
 * signed-in devices and the per-address count are untouched by it, so the owner is never shut out.
 */
export class LoginThrottle {
  private failures = new Map<string, number[]>();
  private all: number[] = [];
  private lastShared = -Infinity;
  constructor(private now: () => number = Date.now) {}

  private recent(who: string): number[] {
    const since = this.now() - FAILURE_WINDOW_MS;
    const list = (this.failures.get(who) ?? []).filter((at) => at > since);
    if (list.length) this.failures.set(who, list);
    else this.failures.delete(who);
    return list;
  }

  /** How long the next try from anywhere has to wait after the last one; 0 below the ceiling. */
  private sharedPause(): number {
    const since = this.now() - GLOBAL_WINDOW_MS;
    this.all = this.all.filter((at) => at > since);
    const over = this.all.length - GLOBAL_FREE_FAILURES;
    if (over < 0) return 0;
    return Math.min(GLOBAL_MAX_PAUSE_MS, GLOBAL_PAUSE_MS * 2 ** Math.floor(over / 10));
  }

  /**
   * Takes one try for `address`, or null when it has to wait. `shared: false` leaves the try out
   * of the count across all addresses, for checks that guessing cannot win (the access key) or
   * that only a signed-in device reaches.
   */
  attempt(address: string, opts: { shared?: boolean } = {}): SignInTry | null {
    const who = addressGroup(address);
    const shared = opts.shared !== false;
    if (this.recent(who).length >= MAX_FAILURES) return null;
    const at = this.now();
    if (shared && at - this.lastShared < this.sharedPause()) return null;
    // Many addresses each failing once must not grow the map for ever.
    if (this.failures.size > 5000) for (const k of [...this.failures.keys()]) this.recent(k);
    this.failures.set(who, [...this.recent(who), at]);
    if (shared) {
      this.all.push(at);
      this.lastShared = at;
    }
    return {
      succeeded: () => {
        this.failures.delete(who);
        if (!shared) return;
        const i = this.all.lastIndexOf(at);
        if (i >= 0) this.all.splice(i, 1);
      },
    };
  }
}
