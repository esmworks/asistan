import {
  ApiAuth,
  ApiCredentialCreate,
  ApiCredentialUpdate,
  type ApiCredential,
  type ApiCredentialCreate as CreateInput,
  type ApiCredentialUpdate as UpdateInput,
} from '@yumakbot/shared';
import { asc, eq } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import { HttpError, newId, notFound } from '../util';
import type { VaultService } from './vault';

type Row = typeof schema.apiCredentials.$inferSelect;

const toCredential = (r: Row): ApiCredential => ({
  id: r.id,
  name: r.name,
  origin: r.origin,
  auth: ApiAuth.parse(r.auth),
  label: r.label,
  botIds: r.botIds ?? null,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
  lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
});

/** The most of a response a bot is given; the rest is cut, and it is told so. */
export const MAX_RESPONSE_CHARS = 20_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** Headers the bot may not set: the key goes in the server's own, and these steer the connection. */
const RESERVED_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
]);

export interface ApiCall {
  method: string;
  url: string;
  headers?: Record<string, string>;
  /** JSON (an object or array) is sent as JSON; a string as it is. */
  body?: unknown;
}

export interface ApiResult {
  status: number;
  /** The response's content type, as the service said it. */
  type: string;
  /** The response text with the key taken out; cut at MAX_RESPONSE_CHARS. */
  body: string;
  cut: boolean;
  /** Where a redirect pointed; it is not followed, so the key does not go there. */
  location: string | null;
}

/** Why a call was refused before it left: the bot is told in its own words. */
export class ApiCallError extends Error {
  constructor(
    readonly reason: 'noKey' | 'notAllowed' | 'badUrl' | 'origin' | 'header',
    readonly detail = '',
  ) {
    super(reason);
  }
}

/**
 * API keys the person saved, for bots to call services with. A bot names the key; the server adds
 * it to a request only when the request goes to the key's own origin, and takes it out of whatever
 * comes back. No key reaches a bot, its prompt or a message.
 */
export class ApiCredentialService {
  constructor(
    private ctx: Ctx,
    private vault: VaultService,
    private fetcher: typeof fetch = fetch,
  ) {}

  async list(): Promise<ApiCredential[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.apiCredentials)
      .orderBy(asc(schema.apiCredentials.name));
    return rows.map(toCredential);
  }

  /** The keys a bot may use. */
  async forBot(botId: string): Promise<ApiCredential[]> {
    return (await this.list()).filter((c) => !c.botIds || c.botIds.includes(botId));
  }

  private async row(id: string): Promise<Row> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.apiCredentials)
      .where(eq(schema.apiCredentials.id, id))
      .limit(1);
    if (!row) throw notFound('apiKey');
    return row;
  }

  private async byName(name: string): Promise<Row | null> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.apiCredentials)
      .where(eq(schema.apiCredentials.name, name.trim().toLowerCase()))
      .limit(1);
    return row ?? null;
  }

  async create(raw: CreateInput): Promise<ApiCredential> {
    const input = ApiCredentialCreate.parse(raw);
    if (await this.byName(input.name)) throw new HttpError(409, 'error.apiKeyNameTaken');
    const [row] = await this.ctx.db
      .insert(schema.apiCredentials)
      .values({
        id: newId(),
        name: input.name,
        origin: input.origin,
        auth: input.auth,
        label: input.label,
        secret: this.vault.seal(input.value),
        botIds: input.botIds ?? null,
      })
      .returning();
    this.ctx.bus.refresh({ scope: 'info' });
    return toCredential(row!);
  }

  /**
   * Saves the key a bot asked for under its name: a new one, or a new value (and origin and way
   * of sending) for the one already under that name. The bots that may use it stay as they were.
   */
  async put(raw: CreateInput): Promise<ApiCredential> {
    const input = ApiCredentialCreate.parse(raw);
    const existing = await this.byName(input.name);
    if (!existing) return this.create(input);
    return this.update(existing.id, {
      origin: input.origin,
      auth: input.auth,
      value: input.value,
      ...(input.label && { label: input.label }),
    });
  }

  async update(id: string, raw: UpdateInput): Promise<ApiCredential> {
    const input = ApiCredentialUpdate.parse(raw);
    await this.row(id);
    const [row] = await this.ctx.db
      .update(schema.apiCredentials)
      .set({
        ...(input.origin !== undefined && { origin: input.origin }),
        ...(input.auth !== undefined && { auth: input.auth }),
        ...(input.label !== undefined && { label: input.label }),
        ...(input.value !== undefined && { secret: this.vault.seal(input.value) }),
        ...(input.botIds !== undefined && { botIds: input.botIds }),
        updatedAt: new Date(),
      })
      .where(eq(schema.apiCredentials.id, id))
      .returning();
    this.ctx.bus.refresh({ scope: 'info' });
    return toCredential(row!);
  }

  async remove(id: string): Promise<void> {
    await this.row(id);
    await this.ctx.db.delete(schema.apiCredentials).where(eq(schema.apiCredentials.id, id));
    this.ctx.bus.refresh({ scope: 'info' });
  }

  /**
   * Calls a service with the key saved under `name`, for a bot that may use it. The request must go
   * to the key's origin; redirects are not followed, since a header of the service's own (unlike
   * Authorization) would be carried to wherever the redirect points.
   */
  async call(botId: string, name: string, req: ApiCall, signal?: AbortSignal): Promise<ApiResult> {
    const row = await this.byName(name);
    if (!row) throw new ApiCallError('noKey', name);
    if (row.botIds && !row.botIds.includes(botId)) throw new ApiCallError('notAllowed', name);
    const auth = ApiAuth.parse(row.auth);
    const result = await this.send(row.origin, { auth, value: this.vault.open(row.secret) }, req, signal);
    await this.ctx.db
      .update(schema.apiCredentials)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.apiCredentials.id, row.id));
    return result;
  }

  /** A call to `origin` with no key, for an API the person added that needs none. */
  callOpen(origin: string, req: ApiCall, signal?: AbortSignal): Promise<ApiResult> {
    return this.send(origin, null, req, signal);
  }

  private async send(
    origin: string,
    key: { auth: ApiAuth; value: string } | null,
    req: ApiCall,
    signal?: AbortSignal,
  ): Promise<ApiResult> {
    let url: URL;
    try {
      url = new URL(req.url, origin);
    } catch {
      throw new ApiCallError('badUrl', req.url);
    }
    if (url.origin !== origin || url.username || url.password) throw new ApiCallError('origin', origin);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      const lower = k.toLowerCase();
      if (
        RESERVED_HEADERS.has(lower) ||
        (key?.auth.type === 'header' && lower === key.auth.header.toLowerCase())
      ) {
        throw new ApiCallError('header', k);
      }
      headers.set(k, v);
    }
    if (key?.auth.type === 'bearer') headers.set('authorization', `Bearer ${key.value}`);
    if (key?.auth.type === 'header') headers.set(key.auth.header, key.value);
    if (key?.auth.type === 'basic') {
      headers.set(
        'authorization',
        `Basic ${Buffer.from(`${key.auth.username}:${key.value}`).toString('base64')}`,
      );
    }
    if (key?.auth.type === 'query') url.searchParams.set(key.auth.param, key.value);
    let body: string | undefined;
    if (req.body !== undefined && req.body !== null) {
      if (typeof req.body === 'string') body = req.body;
      else {
        body = JSON.stringify(req.body);
        if (!headers.has('content-type')) headers.set('content-type', 'application/json');
      }
    }
    const method = req.method.toUpperCase();
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const res = await this.fetcher(url, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
      redirect: 'manual',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const text = await readLimited(res, MAX_RESPONSE_BYTES);
    const clean = key ? scrub(text, key.value, key.auth) : text;
    const location = res.headers.get('location');
    return {
      status: res.status,
      type: res.headers.get('content-type') ?? '',
      body: clean.slice(0, MAX_RESPONSE_CHARS),
      cut: clean.length > MAX_RESPONSE_CHARS,
      location: location ? (key ? scrub(location, key.value, key.auth) : location) : null,
    };
  }
}

/** A response's text, read no further than `max` bytes. */
async function readLimited(res: Response, max: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size >= max) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** `text` with the key taken out, in every form a service might echo it back. */
export function scrub(text: string, value: string, auth: ApiAuth): string {
  const forms = new Set([value, encodeURIComponent(value)]);
  if (auth.type === 'basic') forms.add(Buffer.from(`${auth.username}:${value}`).toString('base64'));
  let out = text;
  // Short values would take ordinary words out with them; a real key is never that short.
  for (const f of forms) if (f.length >= 6) out = out.split(f).join('[key]');
  return out;
}
