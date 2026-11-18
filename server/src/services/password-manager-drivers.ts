import { execFile } from 'node:child_process';
// Types only: the SDK itself (with its WebAssembly core) is loaded once 1Password is connected.
import type * as OnePasswordSdk from '@1password/sdk';
import type { PasswordManagerKind, PasswordManagerProblem } from '@yumakbot/shared';

/** A sign-in a password manager holds, as listed: where it may be typed, never its password. */
export interface ManagerEntry {
  /** What the manager finds it by again: ids only, never a name typed by a person. */
  ref: string;
  /** The addresses it is for; `exact` when the manager fills it on that host alone, not its subdomains. */
  urls: { url: string; exact: boolean }[];
}

/** A sign-in's values, read from the manager only when a page asks for it. */
export interface ManagerLogin {
  username: string;
  password: string;
  /** The authenticator setup as the manager keeps it (a secret or an otpauth link), when there is one. */
  totp: string | null;
}

export interface ManagerDriver {
  /** Signs in when needed and lists the sign-ins in the vault or folder bots may read. */
  entries(signal?: AbortSignal): Promise<ManagerEntry[]>;
  login(ref: string, signal?: AbortSignal): Promise<ManagerLogin>;
}

/** Why a manager could not be read; kept on its row and shown to its owner. */
export class ManagerError extends Error {
  constructor(
    readonly problem: PasswordManagerProblem,
    detail = '',
  ) {
    super(detail || problem);
  }
}

/** What a manager is connected with; sealed in the database, opened only to run its driver. */
export type ManagerSecret = { token: string } | { clientId: string; clientSecret: string; password: string };

export interface DriverSetup {
  kind: PasswordManagerKind;
  secret: ManagerSecret;
  /** The vault or folder to read; empty for all the account sees. */
  scope: string;
  server: string | null;
  /** A folder of the data folder kept for this manager alone: its sign-in state lives there. */
  stateDir: string;
}

export type DriverFactory = (setup: DriverSetup) => ManagerDriver;

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a manager's command-line program. Secrets go in `env`, never in `args`: arguments are seen
 * by anyone on the machine who lists processes. The program gets only the variables named here
 * and the search path, so the server's own secrets stay out of it.
 */
export type Run = (
  cmd: string,
  args: string[],
  env: Record<string, string>,
  signal?: AbortSignal,
) => Promise<RunResult>;

export const run: Run = (cmd, args, env, signal) =>
  new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        env: { PATH: process.env.PATH ?? '', ...env },
        timeout: 60_000,
        maxBuffer: 32 * 1024 * 1024,
        signal,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          return reject(new ManagerError('noCli', cmd));
        }
        if (err && typeof (err as { code?: unknown }).code !== 'number') return reject(err);
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr });
      },
    );
  });

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ManagerError('failed', 'unreadable answer');
  }
};

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const text = (v: unknown) => (typeof v === 'string' ? v : '');

/** How long the values a list read carried are used before a sign-in is read on its own. */
const RECENT_MS = 30_000;

/** A manager's own ids: letters, digits and the few marks they use; anything else is not passed on. */
const ID = /^[A-Za-z0-9_=-]{1,200}$/;

/**
 * Why a 1Password call failed: a token refused or run out is `auth`; anything else (no network,
 * too many requests, the SDK's core not loading) is `failed`, so a good token is not taken for a
 * bad one. The SDK names its own errors by class and message only.
 */
export function onePasswordProblem(err: unknown): ManagerError {
  if (err instanceof ManagerError) return err;
  const name = err instanceof Error ? err.constructor.name : '';
  const message = err instanceof Error ? err.message : String(err);
  if (name === 'RateLimitExceededError') return new ManagerError('failed', message);
  const auth =
    name === 'AuthExpiredError' ||
    /unauthori[sz]ed|forbidden|invalid (service account )?token|token (is )?(invalid|expired|revoked)|authenticat|signature/i.test(
      message,
    );
  return new ManagerError(auth ? 'auth' : 'failed', message);
}

/** The 1Password SDK module, as `import()` gives it. */
export type OnePasswordModule = typeof OnePasswordSdk;

/**
 * 1Password, through its SDK with a service account's token. A service account sees only the
 * vaults it was given, so the account itself is where access is limited; `scope` narrows it to one
 * vault by name. Only active Login items are read, and a website set never to fill is left out.
 */
export function onePassword(
  setup: DriverSetup,
  load: () => Promise<OnePasswordModule> = () => import('@1password/sdk'),
): ManagerDriver {
  if (!('token' in setup.secret)) throw new ManagerError('auth');
  const token = setup.secret.token;
  let client: Promise<OnePasswordSdk.Client> | null = null;
  const open = () => {
    client ??= load()
      .then((sdk) => sdk.createClient({ auth: token, integrationName: 'Yumak Bot', integrationVersion: '1' }))
      .catch((err: unknown) => {
        client = null;
        throw onePasswordProblem(err);
      });
    return client;
  };
  /** A step with the client; a token that ran out since lets the next step make a new one. */
  const call = async <T>(step: (c: OnePasswordSdk.Client) => Promise<T>): Promise<T> => {
    try {
      return await step(await open());
    } catch (err) {
      const problem = onePasswordProblem(err);
      if (problem.problem === 'auth') client = null;
      throw problem;
    }
  };
  return {
    entries: () =>
      call(async (c) => {
        const vaults = (await c.vaults.list()).filter((v) => !setup.scope || v.title === setup.scope);
        if (setup.scope && !vaults.length) throw new ManagerError('scope', setup.scope);
        const out: ManagerEntry[] = [];
        for (const v of vaults) {
          const items = await c.items.list(v.id, {
            type: 'ByState',
            content: { active: true, archived: false },
          });
          for (const it of items) {
            if (it.category !== 'Login') continue;
            out.push({
              ref: `${v.id}/${it.id}`,
              urls: it.websites
                .filter((w) => w.autofillBehavior !== 'Never')
                .map((w) => ({ url: w.url, exact: w.autofillBehavior === 'ExactDomain' })),
            });
          }
        }
        return out;
      }),
    async login(ref) {
      const [vaultId, itemId] = ref.split('/');
      if (!vaultId || !itemId || !ID.test(vaultId) || !ID.test(itemId))
        throw new ManagerError('failed', 'ref');
      const item = await call((c) => c.items.get(vaultId, itemId));
      const field = (id: string, type: string) =>
        item.fields.find((f) => f.id === id) ?? item.fields.find((f) => f.fieldType === type);
      return {
        username: field('username', 'Email')?.value ?? '',
        password: field('password', 'Concealed')?.value ?? '',
        totp: item.fields.find((f) => f.fieldType === 'Totp')?.value || null,
      };
    },
  };
}

/**
 * Bitwarden, through its `bw` program, signed in with the account's API key and unlocked with the
 * master password; all three go to it as environment variables. Its sign-in state lives in the
 * manager's own folder, apart from any `bw` the machine's user has signed in. Only the folder
 * named in `scope` is read, and an item that asks for the master password again is left out.
 */
export function bitwarden(
  setup: DriverSetup,
  exec: Run = run,
  cmd = process.env.YUMAKBOT_BW_PATH || 'bw',
): ManagerDriver {
  if (!('clientId' in setup.secret)) throw new ManagerError('auth');
  const s = setup.secret;
  const base = { BITWARDENCLI_APPDATA_DIR: setup.stateDir, HOME: setup.stateDir };
  let session: string | null = null;
  let recent = new Map<string, ManagerLogin>();
  let recentUntil = 0;
  let forget: NodeJS.Timeout | undefined;
  const loginOf = (it: Record<string, unknown>): ManagerLogin => {
    const l = record(it.login);
    return { username: text(l.username), password: text(l.password), totp: text(l.totp) || null };
  };
  const bw = async (args: string[], env: Record<string, string> = {}, signal?: AbortSignal) => {
    const r = await exec(cmd, [...args, '--nointeraction'], { ...base, ...env }, signal);
    if (r.code !== 0) throw new ManagerError('failed', r.stderr.trim().slice(0, 300));
    return r.stdout;
  };
  const asAuth = async <T>(step: () => Promise<T>): Promise<T> => {
    try {
      return await step();
    } catch (err) {
      if (err instanceof ManagerError && err.problem === 'failed')
        throw new ManagerError('auth', err.message);
      throw err;
    }
  };
  const unlock = async (signal?: AbortSignal) => {
    if (session) return session;
    const status = text(record(parseJson(await bw(['status'], {}, signal))).status);
    if (status === 'unauthenticated') {
      if (setup.server) await bw(['config', 'server', setup.server], {}, signal);
      await asAuth(() =>
        bw(['login', '--apikey'], { BW_CLIENTID: s.clientId, BW_CLIENTSECRET: s.clientSecret }, signal),
      );
    }
    const key = (
      await asAuth(() =>
        bw(['unlock', '--passwordenv', 'BW_PASSWORD', '--raw'], { BW_PASSWORD: s.password }, signal),
      )
    ).trim();
    if (!key) throw new ManagerError('auth');
    session = key;
    return key;
  };
  /** A step with the vault unlocked; a session that ran out is opened again once. */
  const unlocked = async <T>(step: (env: Record<string, string>) => Promise<T>, signal?: AbortSignal) => {
    for (let attempt = 0; ; attempt++) {
      const env = { BW_SESSION: await unlock(signal) };
      try {
        return await step(env);
      } catch (err) {
        if (attempt || !(err instanceof ManagerError) || err.problem !== 'failed') throw err;
        session = null;
      }
    }
  };
  return {
    entries: (signal) =>
      unlocked(async (env) => {
        await bw(['sync'], env, signal);
        const folders = parseJson(await bw(['list', 'folders'], env, signal));
        const folder = (Array.isArray(folders) ? folders : [])
          .map(record)
          .find((f) => text(f.name) === setup.scope);
        const id = text(folder?.id);
        if (!id || !ID.test(id)) throw new ManagerError('scope', setup.scope);
        const items = parseJson(await bw(['list', 'items', '--folderid', id], env, signal));
        const logins = (Array.isArray(items) ? items : [])
          .map(record)
          .filter((it) => it.type === 1 && it.reprompt !== 1 && ID.test(text(it.id)));
        // The list already carries the values: the sign-ins a page asks for right after this read
        // are taken from it, not read a second time. Kept only briefly, then let go.
        recent = new Map(logins.map((it) => [text(it.id), loginOf(it)]));
        recentUntil = Date.now() + RECENT_MS;
        clearTimeout(forget);
        forget = setTimeout(() => recent.clear(), RECENT_MS);
        forget.unref();
        return logins.map((it) => ({
          ref: text(it.id),
          urls: (Array.isArray(record(it.login).uris) ? (record(it.login).uris as unknown[]) : [])
            .map((u) => record(u))
            // The match setting: 0 or none the base domain, 1 the host, 2 an address that starts
            // with it, 3 the exact address, 4 a regular expression, 5 never. A regular expression
            // is not read and "never" is left out; 1 to 3 are filled on the address's host alone.
            .filter((u) => u.match !== 4 && u.match !== 5)
            .map((u) => ({ url: text(u.uri), exact: u.match === 1 || u.match === 2 || u.match === 3 }))
            .filter((u) => u.url),
        }));
      }, signal),
    login: (ref, signal) =>
      unlocked(async (env) => {
        if (!ID.test(ref)) throw new ManagerError('failed', 'ref');
        if (Date.now() < recentUntil) {
          // A list that left the password out is no answer: the item is read on its own.
          const kept = recent.get(ref);
          if (kept?.password) return kept;
        } else recent.clear();
        const it = record(parseJson(await bw(['get', 'item', ref], env, signal)));
        if (it.type !== 1 || it.reprompt === 1) throw new ManagerError('failed', 'not a sign-in');
        return loginOf(it);
      }, signal),
  };
}

/** The first array held under `key` anywhere in `v`, however deep: the JSON shape is read loosely. */
function findArray(v: unknown, key: string, depth = 0): unknown[] | null {
  if (!v || typeof v !== 'object' || depth > 6) return null;
  if (!Array.isArray(v) && Array.isArray((v as Record<string, unknown>)[key])) {
    return (v as Record<string, unknown[]>)[key]!;
  }
  for (const child of Object.values(v)) {
    const found = findArray(child, key, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Proton Pass, through its `pass-cli` program, signed in with a personal access token given to it
 * as an environment variable. The token is made in Proton Pass with access to the vaults bots may
 * read; `scope` narrows it to one vault by name. A session ends after a while: it is signed in again.
 */
export function protonPass(
  setup: DriverSetup,
  exec: Run = run,
  cmd = process.env.YUMAKBOT_PASS_CLI_PATH || 'pass-cli',
): ManagerDriver {
  if (!('token' in setup.secret)) throw new ManagerError('auth');
  const token = setup.secret.token;
  const env = { PROTON_PASS_SESSION_DIR: `${setup.stateDir}/session`, HOME: setup.stateDir };
  let signedIn = false;
  const pass = (args: string[], signal?: AbortSignal) => exec(cmd, args, env, signal);
  const signIn = async (signal?: AbortSignal) => {
    if (signedIn) return;
    if ((await pass(['info'], signal)).code !== 0) {
      const r = await exec(cmd, ['login'], { ...env, PROTON_PASS_PERSONAL_ACCESS_TOKEN: token }, signal);
      if (r.code !== 0) throw new ManagerError('auth', r.stderr.trim().slice(0, 300));
    }
    signedIn = true;
  };
  /**
   * A command that, failing because the session ended, is run again after signing in anew. A
   * failure with the session still good (a field the item does not have) is the answer itself.
   */
  const read = async (args: string[], signal?: AbortSignal) => {
    await signIn(signal);
    const r = await pass(args, signal);
    if (r.code === 0 || (await pass(['info'], signal)).code === 0) return r;
    signedIn = false;
    await signIn(signal);
    return pass(args, signal);
  };
  /** Whether the account shows a vault by this name; the names are read loosely from the JSON. */
  const hasVault = async (name: string, signal?: AbortSignal) => {
    const r = await read(['vault', 'list', '--output', 'json'], signal);
    if (r.code !== 0) return null;
    const names: string[] = [];
    const walk = (v: unknown, depth = 0) => {
      if (!v || typeof v !== 'object' || depth > 6) return;
      for (const [k, x] of Object.entries(v)) {
        if ((k === 'name' || k === 'title') && typeof x === 'string') names.push(x);
        else walk(x, depth + 1);
      }
    };
    try {
      walk(JSON.parse(r.stdout));
    } catch {
      return null;
    }
    return names.includes(name);
  };
  const field = async (ref: string, name: string, signal?: AbortSignal) => {
    const r = await read(['item', 'view', `pass://${ref}/${name}`], signal);
    return r.code === 0 ? r.stdout.replace(/\r?\n$/, '') : '';
  };
  return {
    async entries(signal) {
      const r = await read(
        [
          'item',
          'list',
          ...(setup.scope ? ['--vault-name', setup.scope] : []),
          '--filter-type',
          'login',
          '--filter-state',
          'active',
          '--output',
          'json',
        ],
        signal,
      );
      if (r.code !== 0) {
        // A vault name the account does not show is said as such; any other failure is not.
        const missing = setup.scope && (await hasVault(setup.scope, signal)) === false;
        throw new ManagerError(missing ? 'scope' : 'failed', r.stderr.trim().slice(0, 300));
      }
      const all = parseJson(r.stdout);
      const items = Array.isArray(all) ? all : (findArray(all, 'items') ?? []);
      return items.map(record).flatMap((it): ManagerEntry[] => {
        const share = text(it.share_id ?? it.shareId);
        const id = text(it.id ?? it.item_id ?? it.itemId);
        if (!ID.test(share) || !ID.test(id)) return [];
        const urls = (findArray(it, 'urls') ?? []).map(text).filter(Boolean);
        return [{ ref: `${share}/${id}`, urls: urls.map((url) => ({ url, exact: false })) }];
      });
    },
    async login(ref, signal) {
      const [share, id] = ref.split('/');
      if (!share || !id || !ID.test(share) || !ID.test(id)) throw new ManagerError('failed', 'ref');
      const password = await field(ref, 'password', signal);
      if (!password) throw new ManagerError('failed', 'no password');
      return {
        username: (await field(ref, 'username', signal)) || (await field(ref, 'email', signal)),
        password,
        totp: (await field(ref, 'totp?totp=uri', signal)) || null,
      };
    },
  };
}

export const defaultDrivers: DriverFactory = (setup) =>
  setup.kind === 'onepassword'
    ? onePassword(setup)
    : setup.kind === 'bitwarden'
      ? bitwarden(setup)
      : protonPass(setup);
