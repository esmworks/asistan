import {
  ApiSourceCreate,
  internalHost,
  type ApiOperation,
  type ApiSource,
  type ApiSourceCreate as CreateInput,
} from '@leafbot/shared';
import { asc, eq } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import { HttpError, newId, notFound } from '../util';
import { ApiCallError, type ApiCredentialService, type ApiResult } from './api-credentials';
import { fetchPublicText } from './skill-link';

type Row = typeof schema.apiSources.$inferSelect;

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head'] as const;
const MAX_OPERATIONS = 400;
const SPEC_MAX = 4 * 1024 * 1024;
/** A request body's schema as the bot is shown it, cut to this. */
const BODY_CHARS = 1500;

const toSource = (r: Row): ApiSource => ({
  id: r.id,
  name: r.name,
  title: r.title,
  specUrl: r.specUrl,
  baseUrl: r.baseUrl,
  credential: r.credential,
  operations: r.operations.length,
  botIds: r.botIds ?? null,
  createdAt: r.createdAt.toISOString(),
});

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** What a local `$ref` (`#/components/schemas/Pet`) points at in the document; the value itself otherwise. */
function deref(spec: Json, v: unknown, depth = 0): Json {
  const o = obj(v);
  const ref = str(o.$ref);
  if (!ref.startsWith('#/') || depth > 8) return o;
  let cur: unknown = spec;
  for (const part of ref.slice(2).split('/')) cur = obj(cur)[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  return deref(spec, cur, depth + 1);
}

/** A schema with its references filled in, a few levels deep; deeper ones keep their name. */
function expand(spec: Json, v: unknown, depth = 0): unknown {
  if (Array.isArray(v)) return v.map((x) => expand(spec, x, depth));
  if (!v || typeof v !== 'object') return v;
  const o = v as Json;
  if (typeof o.$ref === 'string') {
    if (depth >= 3) return { $ref: o.$ref.split('/').pop() };
    return expand(spec, deref(spec, o), depth + 1);
  }
  const out: Json = {};
  for (const [k, x] of Object.entries(o)) {
    if (k === 'example' || k === 'examples' || k === 'xml') continue;
    out[k] = expand(spec, x, depth);
  }
  return out;
}

/** `GET /pets/{id}` → `get_pets_id`, for an operation without an id. */
const opId = (method: string, path: string) =>
  `${method}_${path
    .replace(/[{}]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')}`.slice(0, 120);

/**
 * The operations of an OpenAPI 3 (or Swagger 2) document, with the address its first server
 * names. Each operation keeps what a bot needs to call it: method, path, parameters and the
 * request body's schema, shortened.
 */
export function readSpec(spec: Json): { title: string; server: string | null; operations: ApiOperation[] } {
  const info = obj(spec.info);
  let server: string | null = null;
  const servers = Array.isArray(spec.servers) ? spec.servers : [];
  if (servers.length) server = str(obj(servers[0]).url) || null;
  else if (typeof spec.host === 'string') {
    const schemes: unknown[] = Array.isArray(spec.schemes) ? spec.schemes : [];
    const scheme = schemes.includes('https') || !schemes.length ? 'https' : str(schemes[0]) || 'https';
    server = `${scheme}://${spec.host}${str(spec.basePath)}`;
  }
  const operations: ApiOperation[] = [];
  for (const [path, rawItem] of Object.entries(obj(spec.paths))) {
    const item = deref(spec, rawItem);
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of METHODS) {
      if (!item[method] || operations.length >= MAX_OPERATIONS) continue;
      const op = obj(item[method]);
      const params: ApiOperation['params'] = [];
      let body = '';
      for (const p of [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
        const param = deref(spec, p);
        const where = str(param.in);
        if (where === 'body') {
          body = JSON.stringify(expand(spec, param.schema)).slice(0, BODY_CHARS);
          continue;
        }
        if (!['path', 'query', 'header'].includes(where)) continue;
        const schema = deref(spec, param.schema);
        const type = str(schema.type) || str(param.type) || 'string';
        const known = params.findIndex((x) => x.name === str(param.name) && x.in === where);
        const entry = {
          name: str(param.name),
          in: where,
          required: where === 'path' || param.required === true,
          type,
        };
        if (known >= 0) params[known] = entry;
        else params.push(entry);
      }
      const content = obj(deref(spec, op.requestBody).content);
      const json = content['application/json'] ?? Object.values(content)[0];
      if (json) body = JSON.stringify(expand(spec, obj(json).schema)).slice(0, BODY_CHARS);
      operations.push({
        id: (str(op.operationId) || opId(method, path)).slice(0, 120),
        method: method.toUpperCase(),
        path,
        summary: (str(op.summary) || str(op.description)).replace(/\s+/g, ' ').trim().slice(0, 300),
        params,
        body,
      });
    }
  }
  return { title: str(info.title).slice(0, 200), server, operations };
}

/** An API's address: https, or plain http to a host on the private network. */
function apiBase(raw: string, relativeTo?: string): string {
  let url: URL;
  try {
    url = new URL(raw, relativeTo);
  } catch {
    throw new HttpError(400, 'error.openapiServer');
  }
  if (url.username || url.password) throw new HttpError(400, 'error.openapiServer');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && internalHost(url.hostname)))
    throw new HttpError(400, 'error.openapiServer');
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/, '');
}

/**
 * OpenAPI documents the person added for bots to call. A bot lists an API's operations and calls
 * one by its id; the server builds the request from the document and sends it to the API's own
 * address, with the API key the person chose added by the server, as for any saved key.
 */
export class ApiSourceService {
  constructor(
    private ctx: Ctx,
    private keys: ApiCredentialService,
    private fetchText: typeof fetchPublicText = fetchPublicText,
  ) {}

  async list(): Promise<ApiSource[]> {
    const rows = await this.ctx.db.select().from(schema.apiSources).orderBy(asc(schema.apiSources.name));
    return rows.map(toSource);
  }

  async forBot(botId: string): Promise<ApiSource[]> {
    return (await this.list()).filter((s) => !s.botIds || s.botIds.includes(botId));
  }

  private async row(id: string): Promise<Row> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.apiSources)
      .where(eq(schema.apiSources.id, id))
      .limit(1);
    if (!row) throw notFound('apiSource');
    return row;
  }

  private async byName(name: string): Promise<Row | null> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.apiSources)
      .where(eq(schema.apiSources.name, name.trim().toLowerCase()))
      .limit(1);
    return row ?? null;
  }

  private async load(specUrl: string | undefined, pasted: string | undefined) {
    let text = pasted;
    if (!text && specUrl) {
      let url: URL;
      try {
        url = new URL(specUrl);
      } catch {
        throw new HttpError(400, 'error.skillLinkInvalid');
      }
      text = await this.fetchText(url, SPEC_MAX);
    }
    let spec: unknown;
    try {
      spec = JSON.parse(text ?? '');
    } catch {
      throw new HttpError(400, 'error.openapiFormat');
    }
    const read = readSpec(obj(spec));
    if (!read.operations.length) throw new HttpError(400, 'error.openapiEmpty');
    return read;
  }

  async create(raw: CreateInput): Promise<ApiSource> {
    const input = ApiSourceCreate.parse(raw);
    if (await this.byName(input.name)) throw new HttpError(409, 'error.openapiNameTaken');
    const read = await this.load(input.specUrl, input.spec);
    const server = input.baseUrl || read.server;
    if (!server) throw new HttpError(400, 'error.openapiServer');
    const [row] = await this.ctx.db
      .insert(schema.apiSources)
      .values({
        id: newId(),
        name: input.name,
        title: read.title,
        specUrl: input.specUrl || null,
        baseUrl: apiBase(server, input.specUrl || undefined),
        credential: input.credential,
        operations: read.operations,
        botIds: input.botIds ?? null,
      })
      .returning();
    return toSource(row!);
  }

  /** Reads the document again from its address, for an API whose operations changed. */
  async refresh(id: string): Promise<ApiSource> {
    const row = await this.row(id);
    if (!row.specUrl) return toSource(row);
    const read = await this.load(row.specUrl, undefined);
    const [updated] = await this.ctx.db
      .update(schema.apiSources)
      .set({ operations: read.operations, title: read.title, updatedAt: new Date() })
      .where(eq(schema.apiSources.id, id))
      .returning();
    return toSource(updated!);
  }

  async remove(id: string): Promise<void> {
    await this.row(id);
    await this.ctx.db.delete(schema.apiSources).where(eq(schema.apiSources.id, id));
  }

  /** The operations of an API the bot may use, those matching `query` when given. */
  async operations(botId: string, name: string, query?: string): Promise<ApiOperation[] | null> {
    const row = await this.byName(name);
    if (!row || (row.botIds && !row.botIds.includes(botId))) return null;
    const ops = row.operations as unknown as ApiOperation[];
    const q = query?.trim().toLowerCase();
    return q
      ? ops.filter((o) => `${o.id} ${o.method} ${o.path} ${o.summary}`.toLowerCase().includes(q))
      : ops;
  }

  /**
   * Calls an operation for a bot: the path's parameters filled in, the query and headers set, the
   * body sent as JSON, to the API's own address and with its key.
   */
  async call(
    botId: string,
    /** Whom the bot works for (null in a team conversation): their own key goes before the team's. */
    userId: string | null,
    name: string,
    operation: string,
    args: { params?: Record<string, unknown>; body?: unknown },
    signal?: AbortSignal,
  ): Promise<ApiResult> {
    const row = await this.byName(name);
    if (!row || (row.botIds && !row.botIds.includes(botId))) throw new ApiCallError('noKey', name);
    const op = (row.operations as unknown as ApiOperation[]).find((o) => o.id === operation);
    if (!op) throw new HttpError(404, 'error.openapiNoOperation', { operation });
    const params = args.params ?? {};
    const missing = op.params.filter(
      (p) => p.required && (params[p.name] === undefined || params[p.name] === ''),
    );
    if (missing.length)
      throw new HttpError(400, 'error.openapiMissing', { names: missing.map((p) => p.name).join(', ') });
    let path = op.path;
    const query = new URLSearchParams();
    const headers: Record<string, string> = {};
    for (const p of op.params) {
      const v = params[p.name];
      if (v === undefined || v === null) continue;
      const text = typeof v === 'object' ? JSON.stringify(v) : String(v);
      if (p.in === 'path') path = path.replace(`{${p.name}}`, encodeURIComponent(text));
      else if (p.in === 'query') query.set(p.name, text);
      else headers[p.name] = text;
    }
    const base = new URL(row.baseUrl);
    const url = `${row.baseUrl}${path}${query.size ? `?${query}` : ''}`;
    const req = { method: op.method, url, headers, body: args.body };
    return row.credential
      ? this.keys.call(botId, userId, row.credential, req, signal)
      : this.keys.callOpen(base.origin, req, signal);
  }
}
