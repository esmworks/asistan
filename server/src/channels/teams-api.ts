import { createPublicKey, verify, type KeyObject, type webcrypto } from 'node:crypto';

type JsonWebKey = webcrypto.JsonWebKey;

/** Who signs what the Bot Framework sends a bot. */
export const TEAMS_ISSUER = 'https://api.botframework.com';
/** The scope a bot's token is asked for, to write through the Bot Connector. */
const CONNECTOR_SCOPE = 'https://api.botframework.com/.default';
/** Clocks of the two sides may disagree by this much. */
const SKEW_S = 5 * 60;
/** The signing keys are read again at least this often, as the Bot Framework asks. */
const KEYS_MS = 24 * 3600_000;
/** A key not known yet makes the keys be read again, but not more often than this. */
const KEYS_RETRY_MS = 5 * 60_000;
/** A token is renewed this long before it runs out. */
const TOKEN_MARGIN_MS = 5 * 60_000;
const WAIT_MS = 15_000;

export type Http = typeof fetch;

/** A message or event as the Bot Framework hands it to the bot; only what is read here. */
export interface TeamsActivity {
  type?: string;
  id?: string;
  serviceUrl?: string;
  channelId?: string;
  from?: { id?: string; name?: string; aadObjectId?: string };
  recipient?: { id?: string; name?: string };
  conversation?: { id?: string; conversationType?: string; tenantId?: string };
  channelData?: { tenant?: { id?: string } };
  text?: string;
  /** What an Adaptive Card's button sends back. */
  value?: unknown;
  attachments?: { contentType?: string; name?: string }[];
}

export class TeamsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

const b64url = (s: string) => Buffer.from(s, 'base64url');
const json = (s: string): unknown => JSON.parse(b64url(s).toString('utf8'));

/** A service address the Bot Framework names: HTTPS, or a loopback address a test runs on. */
export function serviceAddress(raw: unknown): URL | null {
  if (typeof raw !== 'string') return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === 'https:') return url;
  return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ? url : null;
}

const sameService = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

interface Key {
  key: KeyObject;
  endorsements: string[] | null;
}

/**
 * Checks that a request really comes from the Bot Framework for this bot: a token signed with one
 * of its published keys (RS256), from its issuer, for this bot's app id, in date, naming the same
 * service the message does, with a key endorsed for Teams. There is no way to turn this off.
 */
export class TeamsAuth {
  private keys = new Map<string, Key>();
  private readAt = 0;
  private reading: Promise<void> | null = null;

  constructor(
    private openIdUrl: string,
    private http: Http = fetch,
    private now: () => number = Date.now,
  ) {}

  /** Whether the `Authorization` header proves the activity was sent to bot `appId`. */
  async check(header: string | undefined, activity: TeamsActivity, appId: string): Promise<boolean> {
    const token = /^Bearer\s+(\S+)$/i.exec(header ?? '')?.[1];
    if (!token) return false;
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [h, p, sig] = parts as [string, string, string];
    let head: { alg?: unknown; kid?: unknown };
    let claims: Record<string, unknown>;
    try {
      head = json(h) as typeof head;
      claims = json(p) as typeof claims;
    } catch {
      return false;
    }
    if (head.alg !== 'RS256' || typeof head.kid !== 'string' || !claims || typeof claims !== 'object')
      return false;
    const key = await this.key(head.kid);
    if (!key) return false;
    // A key signs only for the channels the Bot Framework endorses it for; one without any is not
    // taken as endorsed for Teams.
    if (activity.channelId !== 'msteams' || !key.endorsements?.includes('msteams')) return false;
    if (!verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key.key, b64url(sig))) return false;
    if (claims.iss !== TEAMS_ISSUER) return false;
    const aud = claims.aud;
    if (!(aud === appId || (Array.isArray(aud) && aud.includes(appId)))) return false;
    const t = this.now() / 1000;
    if (typeof claims.exp !== 'number' || claims.exp + SKEW_S < t) return false;
    if (typeof claims.nbf === 'number' && claims.nbf - SKEW_S > t) return false;
    // The service the token was issued for is the one replies go to; a message naming another is
    // not believed.
    const service = claims.serviceurl ?? claims.serviceUrl;
    if (typeof service !== 'string' || typeof activity.serviceUrl !== 'string') return false;
    return sameService(service, activity.serviceUrl);
  }

  private async key(kid: string): Promise<Key | null> {
    const stale = this.now() - this.readAt > KEYS_MS;
    const unknown = !this.keys.has(kid) && this.now() - this.readAt > KEYS_RETRY_MS;
    if (stale || unknown) await this.read().catch(() => {});
    return this.keys.get(kid) ?? null;
  }

  /**
   * Reads the keys again. The time counts from the try, not from a success, so while Microsoft
   * cannot be reached a stream of made-up tokens does not make the server ask on each one.
   */
  private read(): Promise<void> {
    if (!this.reading) {
      this.readAt = this.now();
      this.reading = this.load().finally(() => (this.reading = null));
    }
    return this.reading;
  }

  private async load() {
    const meta = (await this.get(this.openIdUrl)) as { jwks_uri?: unknown };
    const where = serviceAddress(meta.jwks_uri);
    if (!where) throw new TeamsError(502, 'jwks_uri');
    const set = (await this.get(where.href)) as { keys?: unknown };
    if (!Array.isArray(set.keys)) throw new TeamsError(502, 'keys');
    const keys = new Map<string, Key>();
    for (const k of set.keys as (JsonWebKey & { kid?: unknown; endorsements?: unknown })[]) {
      if (k.kty !== 'RSA' || typeof k.kid !== 'string' || (k.use && k.use !== 'sig')) continue;
      try {
        const { kid, endorsements, ...jwk } = k;
        keys.set(kid as string, {
          key: createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' }),
          endorsements: Array.isArray(endorsements)
            ? endorsements.filter((e): e is string => typeof e === 'string')
            : null,
        });
      } catch {
        // A key that is not a usable RSA key is left out.
      }
    }
    this.keys = keys;
  }

  private async get(url: string): Promise<unknown> {
    const res = await this.http(url, { signal: AbortSignal.timeout(WAIT_MS), redirect: 'error' });
    if (!res.ok) throw new TeamsError(res.status, 'keys');
    return res.json();
  }
}

/** Writes to Teams as the bot: a token from Microsoft's sign-in service, then the Bot Connector. */
export class TeamsConnector {
  private token: { value: string; until: number } | null = null;

  constructor(
    private login: string,
    private tenantId: string,
    private appId: string,
    private secret: string,
    private http: Http = fetch,
    private now: () => number = Date.now,
  ) {}

  /** A token for the Bot Connector; asking for one is also how the secret is checked. */
  async bearer(): Promise<string> {
    if (this.token && this.token.until > this.now()) return this.token.value;
    const res = await this.http(`${this.login}/${encodeURIComponent(this.tenantId)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.appId,
        client_secret: this.secret,
        scope: CONNECTOR_SCOPE,
      }).toString(),
      signal: AbortSignal.timeout(WAIT_MS),
      redirect: 'error',
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (!res.ok || !body.access_token) throw new TeamsError(res.status, body.error ?? `http_${res.status}`);
    const life = (Number(body.expires_in) || 3600) * 1000;
    this.token = { value: body.access_token, until: this.now() + Math.max(life - TOKEN_MARGIN_MS, 60_000) };
    return body.access_token;
  }

  /** Posts an activity into a conversation; the service address must be one Teams named. */
  async send(serviceUrl: string, conversationId: string, activity: Record<string, unknown>): Promise<void> {
    const base = serviceAddress(serviceUrl);
    if (!base) throw new TeamsError(400, 'service_url');
    const url = `${base.href.replace(/\/+$/, '')}/v3/conversations/${encodeURIComponent(conversationId)}/activities`;
    const res = await this.http(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.bearer()}`, 'content-type': 'application/json' },
      body: JSON.stringify(activity),
      signal: AbortSignal.timeout(WAIT_MS),
      redirect: 'error',
    });
    if (res.status === 401) this.token = null;
    if (!res.ok) throw new TeamsError(res.status, `http_${res.status}`);
  }
}

const TAGS =
  /<\/?(?:p|div|span|b|i|u|s|strong|em|code|pre|ul|ol|li|a|img|h[1-6]|blockquote|table|thead|tbody|tr|td|th|strike|del|ins|sup|sub|hr)(?:\s+[\w-]+(?:="[^"]*"|='[^']*'|=[^\s>]+)?)*\s*\/?>/gi;

/** What a person wrote in Teams, as plain text: mentions of the bot and markup taken out. */
export function teamsText(raw: string | undefined): string {
  return (
    (raw ?? '')
      .replace(/<at>[^<]*<\/at>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|li)>\s*<(?:p|div|li)(?:\s[^>]*)?>/gi, '\n')
      // Only the markup Teams puts around formatted text; anything else that looks like a tag is
      // what the person wrote.
      .replace(TAGS, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/[ \t]+/g, ' ')
      .trim()
  );
}

/** Teams takes about 28 KB in one message; longer replies go out in parts, split between lines. */
const PART_MAX = 20_000;

export function teamsParts(text: string): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > PART_MAX) {
    const cut = rest.lastIndexOf('\n', PART_MAX);
    const at = cut > PART_MAX / 2 ? cut : PART_MAX;
    out.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}
