import { getModels } from '@earendil-works/pi-ai/compat';
import { EFFORTS, type ModelInfo } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from '../src/context';
import { ProviderKeyService } from '../src/services/keys';
import { ModelCatalogService, trimCatalog } from '../src/services/model-catalog';
import { testServer, type TestServer } from './helpers';

const URL = 'https://catalog.test/api.json';
const listedId = (getModels('xai' as never) as { id: string }[])[0]!.id;

const CATALOG = {
  xai: {
    id: 'xai',
    name: 'xAI',
    models: {
      [listedId]: { name: 'Listedeki Grok', reasoning: true, release_date: '2020-01-01' },
      'grok-yeni': {
        name: 'Grok Yeni',
        reasoning: true,
        tool_call: true,
        release_date: '2099-01-01',
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 500_000, output: 40_000 },
        cost: { input: 2, output: 8, cache_read: 0.5 },
      },
      'grok-resim': {
        name: 'Grok Resim',
        tool_call: true,
        modalities: { input: ['text'], output: ['image'] },
      },
      'grok-aracsiz': { name: 'Grok Araçsız', tool_call: false },
      'grok-eski': { name: 'Grok Eski', tool_call: true, status: 'deprecated' },
      bozuk: 42,
    },
  },
  uydurma: { name: 'Uydurma', models: { a: { name: 'A' } } },
};

function catalogFetch(body: unknown = CATALOG) {
  const calls: string[] = [];
  let fail = false;
  const fetcher = (async (url: string) => {
    calls.push(url);
    if (fail) throw new Error('ağ yok');
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return {
    fetcher,
    calls,
    setFail(v: boolean) {
      fail = v;
    },
  };
}

describe('model kataloğu', () => {
  let t: TestServer;
  let ctx: Ctx;
  let now: number;
  const providers = () => ['xai', 'openai'];
  beforeEach(async () => {
    t = await testServer();
    ctx = { ...t.services.ctx, config: { ...t.services.ctx.config, modelCatalogUrl: URL } };
    now = Date.parse('2026-11-18T09:00:00Z');
  });
  afterEach(() => t.dispose());

  it('yalnızca motorun bildiği sağlayıcıları ve geçerli girdileri tutar', () => {
    const kept = trimCatalog(CATALOG, providers());
    expect(Object.keys(kept)).toEqual(['xai']);
    expect(kept.xai!.name).toBe('xAI');
    expect(kept.xai!.models.bozuk).toBeUndefined();
    expect(kept.xai!.models['grok-yeni']).toEqual({
      name: 'Grok Yeni',
      reasoning: true,
      tools: true,
      images: true,
      chat: true,
      deprecated: false,
      contextWindow: 500_000,
      maxTokens: 40_000,
      released: '2099-01-01',
      cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },
    });
    expect(kept.xai!.models['grok-resim']!.chat).toBe(false);
    expect(kept.xai!.models['grok-aracsiz']!.tools).toBe(false);
    expect(kept.xai!.models['grok-eski']!.deprecated).toBe(true);
    expect(trimCatalog(null, providers())).toEqual({});
  });

  it('kataloğu arka planda indirir, saklar ve günde bir yeniler', async () => {
    const net = catalogFetch();
    const catalog = new ModelCatalogService(ctx, providers, net.fetcher, () => now);
    // The first look starts the download without waiting for it.
    expect(await catalog.provider('xai')).toBeUndefined();
    await catalog.settled();
    expect(net.calls).toEqual([URL]);
    expect((await catalog.provider('xai'))?.models['grok-yeni']?.name).toBe('Grok Yeni');
    await catalog.settled();
    expect(net.calls).toHaveLength(1);

    // A restart reads the kept catalog without downloading it again.
    const again = catalogFetch();
    const restarted = new ModelCatalogService(ctx, providers, again.fetcher, () => now);
    expect((await restarted.provider('xai'))?.name).toBe('xAI');
    await restarted.settled();
    expect(again.calls).toHaveLength(0);

    now += 25 * 60 * 60 * 1000;
    await restarted.provider('xai');
    await restarted.settled();
    expect(again.calls).toHaveLength(1);
  });

  it('indirilemeyince motorun listesiyle sürer ve bir saat bekleyip yeniden dener', async () => {
    const net = catalogFetch();
    net.setFail(true);
    const catalog = new ModelCatalogService(ctx, providers, net.fetcher, () => now);
    await catalog.start();
    await catalog.settled();
    expect(await catalog.provider('xai')).toBeUndefined();
    await catalog.settled();
    expect(net.calls).toHaveLength(1);

    net.setFail(false);
    now += 61 * 60 * 1000;
    await catalog.provider('xai');
    await catalog.settled();
    expect(net.calls).toHaveLength(2);
    expect(await catalog.provider('xai')).toBeDefined();
  });

  it('kapalıyken hiç indirmez', async () => {
    const net = catalogFetch();
    const off = { ...ctx, config: { ...ctx.config, modelCatalogUrl: null } };
    const catalog = new ModelCatalogService(off, providers, net.fetcher, () => now);
    await catalog.start();
    expect(await catalog.provider('xai')).toBeUndefined();
    expect(net.calls).toHaveLength(0);
  });

  it('model listesine adları ve yeni çıkan sohbet modellerini katar, en yeniyi başa alır', async () => {
    const net = catalogFetch();
    const catalog = new ModelCatalogService(ctx, providers, net.fetcher, () => now);
    await catalog.refresh();
    const keys = new ProviderKeyService(ctx, t.services.vault, fetch, undefined, catalog);
    const list = await keys.modelInfo('xai');
    const ids = list.map((m) => m.id);
    expect(ids[0]).toBe('grok-yeni');
    expect(ids).not.toContain('grok-resim');
    expect(ids).not.toContain('grok-aracsiz');
    expect(ids).not.toContain('grok-eski');
    expect(ids).toContain(listedId);
    expect(list.find((m) => m.id === listedId)?.name).toBe('Listedeki Grok');
    expect(list[0]).toMatchObject({
      name: 'Grok Yeni',
      images: true,
      contextWindow: 500_000,
      released: '2099-01-01',
    });

    // The new model runs with the catalog's limits and price, reached the way its sibling is.
    const made = await keys.customModel('xai', 'grok-yeni');
    expect(made).toMatchObject({
      id: 'grok-yeni',
      name: 'Grok Yeni',
      reasoning: true,
      input: ['text', 'image'],
      contextWindow: 500_000,
      maxTokens: 40_000,
      cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },
      provider: 'xai',
    });
    expect(made?.baseUrl).toMatch(/^https:/);
  });

  it('her modelin düşünme düzeylerini motorun göndereceği gibi verir', async () => {
    const r = await t.api<ModelInfo[]>('GET', '/api/providers/openai/model-info');
    expect(r.status).toBe(200);
    const all = (getModels('openai' as never) as { id: string; reasoning: boolean }[]).map((m) => m.id);
    expect(r.body.map((m) => m.id).sort()).toEqual([...all].sort());
    for (const m of r.body) {
      expect(m.efforts).not.toBeNull();
      for (const e of m.efforts!) expect(EFFORTS).toContain(e);
    }
    const plain = (getModels('openai' as never) as { id: string; reasoning: boolean }[]).find(
      (m) => !m.reasoning,
    );
    if (plain) expect(r.body.find((m) => m.id === plain.id)?.efforts).toEqual([]);
    expect(r.body.some((m) => m.efforts!.length > 0)).toBe(true);
    expect((await t.api('GET', '/api/providers/uydurma/model-info')).status).toBe(404);
  });
});
