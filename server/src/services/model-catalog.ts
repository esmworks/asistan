import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../context';
import { schema } from '../db';
import { readCapped } from './read-capped';

const KEY = 'catalog.models';
/** The catalog changes a few times a week; once a day keeps new models a day away at most. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** After a failed download the next try waits this long, so an offline server does not keep trying. */
const RETRY_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 30_000;
/** The whole catalog is a few megabytes; far more than that is not the catalog. */
const MAX_BYTES = 64 * 1024 * 1024;

/** What the catalog says about one model, kept to what the app and the engine use. */
export interface CatalogModel {
  name: string;
  reasoning: boolean;
  /** False only when the catalog says the model cannot call tools. */
  tools: boolean;
  images: boolean;
  /** Text in and text out: a chat model, not one for images, speech or embeddings. */
  chat: boolean;
  deprecated: boolean;
  contextWindow?: number;
  maxTokens?: number;
  /** YYYY-MM-DD. */
  released?: string;
  /** US dollars per million tokens. */
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface CatalogProvider {
  name: string;
  models: Record<string, CatalogModel>;
}

interface Stored {
  at: number;
  providers: Record<string, CatalogProvider>;
}

const num = z.number().finite().nonnegative().optional();
const RawModel = z.object({
  name: z.string().max(200).optional(),
  reasoning: z.boolean().optional(),
  tool_call: z.boolean().optional(),
  status: z.string().optional(),
  release_date: z.string().max(20).optional(),
  modalities: z
    .object({ input: z.array(z.string()).optional(), output: z.array(z.string()).optional() })
    .optional(),
  limit: z.object({ context: num, output: num }).optional(),
  cost: z.object({ input: num, output: num, cache_read: num, cache_write: num }).optional(),
});

const posInt = (v: number | undefined) => (v && Number.isInteger(v) && v > 0 ? v : undefined);

/** One catalog entry in the shape kept here; null for an entry that is not a model. */
export function catalogModel(raw: unknown): CatalogModel | null {
  const r = RawModel.safeParse(raw);
  if (!r.success || !r.data.name) return null;
  const m = r.data;
  const input = m.modalities?.input ?? ['text'];
  const output = m.modalities?.output ?? ['text'];
  const released =
    m.release_date && /^\d{4}-\d{2}(-\d{2})?$/.test(m.release_date) ? m.release_date : undefined;
  return {
    name: m.name!,
    reasoning: m.reasoning === true,
    tools: m.tool_call !== false,
    images: input.includes('image'),
    chat: input.includes('text') && output.length > 0 && output.every((o) => o === 'text'),
    deprecated: m.status === 'deprecated',
    ...(posInt(m.limit?.context) && { contextWindow: posInt(m.limit?.context) }),
    ...(posInt(m.limit?.output) && { maxTokens: posInt(m.limit?.output) }),
    ...(released && { released }),
    ...(m.cost &&
      m.cost.input !== undefined &&
      m.cost.output !== undefined && {
        cost: {
          input: m.cost.input,
          output: m.cost.output,
          cacheRead: m.cost.cache_read ?? 0,
          cacheWrite: m.cost.cache_write ?? 0,
        },
      }),
  };
}

/** The catalog's providers this server can use, each with the models it lists. */
export function trimCatalog(raw: unknown, providers: readonly string[]): Record<string, CatalogProvider> {
  const out: Record<string, CatalogProvider> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const id of providers) {
    const p = (raw as Record<string, unknown>)[id];
    if (!p || typeof p !== 'object') continue;
    const { name, models } = p as { name?: unknown; models?: unknown };
    if (!models || typeof models !== 'object') continue;
    const kept: Record<string, CatalogModel> = {};
    for (const [modelId, entry] of Object.entries(models as Record<string, unknown>)) {
      if (modelId.length > 200) continue;
      const m = catalogModel(entry);
      if (m) kept[modelId] = m;
    }
    out[id] = { name: typeof name === 'string' && name.length <= 100 ? name : id, models: kept };
  }
  return out;
}

/**
 * The public model catalog (models.dev): readable model names, which models think, their limits and
 * prices, and models released after the engine's own list was made. It only adds to that list: what
 * the engine sends where, and with which key, never comes from here.
 *
 * Downloaded at most once a day, in the background, and kept in the database for the next start;
 * without it (offline, turned off) every list is the engine's own.
 */
export class ModelCatalogService {
  private stored: Stored | null | undefined;
  private refreshing: Promise<void> | null = null;
  private failedAt = 0;

  constructor(
    private ctx: Ctx,
    /** The providers worth keeping from the catalog: the ones the engine can reach. */
    private providers: () => readonly string[],
    private fetcher: typeof fetch = fetch,
    private now: () => number = Date.now,
  ) {}

  private get url() {
    return this.ctx.config.modelCatalogUrl;
  }

  /** What the catalog says about a provider; undefined when it says nothing (yet). */
  async provider(id: string): Promise<CatalogProvider | undefined> {
    const stored = await this.load();
    this.refreshIfStale(stored);
    return stored?.providers[id];
  }

  /** Starts a download if the kept catalog is missing or a day old; never waits for it. */
  async start(): Promise<void> {
    this.refreshIfStale(await this.load());
  }

  /** The download in progress, if any; for tests. */
  settled(): Promise<void> {
    return this.refreshing ?? Promise.resolve();
  }

  private async load(): Promise<Stored | null> {
    if (this.stored !== undefined) return this.stored;
    const [row] = await this.ctx.db.select().from(schema.kv).where(eq(schema.kv.key, KEY)).limit(1);
    const v = row?.value as Partial<Stored> | undefined;
    this.stored =
      v && typeof v.at === 'number' && v.providers && typeof v.providers === 'object'
        ? { at: v.at, providers: v.providers }
        : null;
    return this.stored;
  }

  private refreshIfStale(stored: Stored | null) {
    if (!this.url || this.refreshing) return;
    const now = this.now();
    if (stored && now - stored.at < MAX_AGE_MS) return;
    if (now - this.failedAt < RETRY_MS) return;
    this.refreshing = this.refresh()
      .catch(() => {
        this.failedAt = this.now();
      })
      .finally(() => {
        this.refreshing = null;
      });
  }

  /** Downloads the catalog now and keeps it; throws when it cannot be had. */
  async refresh(): Promise<void> {
    const url = this.url;
    if (!url) return;
    const res = await this.fetcher(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`model catalog: HTTP ${res.status}`);
    const body = await readCapped(res.body as AsyncIterable<Uint8Array> | null, MAX_BYTES);
    const providers = trimCatalog(JSON.parse(body.toString('utf8')), this.providers());
    if (!Object.keys(providers).length) throw new Error('model catalog: no known provider');
    const stored: Stored = { at: this.now(), providers };
    await this.ctx.db
      .insert(schema.kv)
      .values({ key: KEY, value: stored })
      .onConflictDoUpdate({ target: schema.kv.key, set: { value: stored } });
    this.stored = stored;
    // Open model lists fill in with what is new.
    this.ctx.bus.refresh({ scope: 'info' });
  }
}
