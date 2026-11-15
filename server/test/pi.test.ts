import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderInfo } from '@yumakbot/shared';
import {
  completeSimple,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  registerFauxProvider,
  streamSimple,
  type FauxProviderRegistration,
} from '@earendil-works/pi-ai/compat';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { schema } from '../src/db';
import {
  announcesAction,
  dropOldImages,
  MAX_STEPS,
  MAX_TOOLS,
  PiEngine,
  providerTrouble,
  trimHistory,
} from '../src/engine/pi';
import { translator } from '../src/i18n';
import { CONTEXT_FULL } from '../src/runtime/turns';
import { endpointUrl, keySafeAt, unlistedModel } from '../src/services/keys';
import { getModels } from '@earendil-works/pi-ai/compat';
import type { AppTool, PermissionAsk, PermissionAnswer, TurnRequest } from '../src/engine/types';
import { testServer, type TestServer } from './helpers';

let faux: FauxProviderRegistration;
beforeAll(() => {
  faux = registerFauxProvider({
    provider: 'deneme',
    models: [{ id: 'm1' }, { id: 'dusunen', reasoning: true }, { id: 'metin', input: ['text'] }],
    tokensPerSecond: 0,
  });
});

describe('Pi motoru', () => {
  let dir: string;
  let cwd: string;
  let outside: string;
  let asks: PermissionAsk[];
  let answer: PermissionAnswer;
  let keys: Record<string, string>;
  let seenKeys: (string | undefined)[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'yumakbot-pi-'));
    cwd = join(dir, 'thread');
    outside = join(dir, 'disari');
    mkdirSync(cwd);
    mkdirSync(outside);
    asks = [];
    answer = { behavior: 'allow' };
    keys = { deneme: 'test-anahtar-12345' };
    seenKeys = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const engine = () =>
    new PiEngine({
      sessionsDir: join(dir, 'sessions'),
      apiKey: async (p) => keys[p] ?? null,
      resolveModel: (p, id) => (p === 'deneme' ? faux.getModel(id) : undefined),
      streamFn: ((model, context, options) => {
        seenKeys.push(options?.apiKey);
        return streamSimple(model, context, options);
      }) as StreamFn,
    });

  const request = (over: Partial<TurnRequest> = {}) => {
    const text: string[] = [];
    const sessions: string[] = [];
    const ctrl = new AbortController();
    const req: TurnRequest = {
      turnId: 't1',
      threadId: 'th1',
      botId: 'b1',
      model: 'deneme/m1',
      prompt: 'merhaba',
      sessionId: null,
      systemPrompt: 'Sen bir test botusun.',
      locale: 'tr',
      sandbox: { cwd, additionalDirectories: [], writable: [cwd], internet: true, readOnly: false },
      shell: 'sandbox',
      tools: [],
      canUseTool: async (ask) => {
        asks.push(ask);
        return answer;
      },
      onText: (d) => text.push(d),
      onSession: (s) => sessions.push(s),
      signal: ctrl.signal,
      ...over,
    };
    return { req, text, sessions, ctrl };
  };

  it('yanıtı akıtır, oturumu saklar ve sonraki turda geçmişle devam eder', async () => {
    faux.setResponses([fauxAssistantMessage('Selam!')]);
    const first = request();
    const out = await engine().run(first.req);
    expect(out).toMatchObject({ ok: true, text: 'Selam!' });
    expect(first.text.join('')).toBe('Selam!');
    expect(first.sessions).toHaveLength(1);
    expect(out.sessionId).toBe(first.sessions[0]);
    // The stored key reaches only the provider call.
    expect(seenKeys).toEqual(['test-anahtar-12345']);

    let seen = 0;
    faux.setResponses([
      (ctx) => {
        seen = ctx.messages.length;
        return fauxAssistantMessage('Hatırlıyorum.');
      },
    ]);
    const second = request({ sessionId: out.sessionId, prompt: 'beni hatırlıyor musun' });
    const out2 = await engine().run(second.req);
    expect(out2).toMatchObject({ ok: true, text: 'Hatırlıyorum.', sessionId: out.sessionId });
    expect(second.sessions).toHaveLength(0);
    // user + assistant from the first turn, then the new user message.
    expect(seen).toBeGreaterThanOrEqual(3);
  });

  it('yapacağını söyleyip araç çağırmadan duran modele devam etmesini söyler', async () => {
    let nudge = '';
    faux.setResponses([
      fauxAssistantMessage('Şimdi dosyaya bakıyorum:'),
      (ctx) => {
        const last = ctx.messages.at(-1);
        nudge =
          last?.role === 'user' && typeof last.content === 'string'
            ? last.content
            : JSON.stringify(last?.content);
        return fauxAssistantMessage('Baktım; dosya boş.');
      },
    ]);
    const out = await engine().run(request().req);
    expect(out).toMatchObject({ ok: true, text: 'Baktım; dosya boş.' });
    expect(nudge).toContain('tool call');
  });

  it('araç sınırını aşınca küçük uygulamaları bütün tutar; sığmayana arayıp onayla ulaşılır', async () => {
    let names: string[] = [];
    let system = '';
    const found: string[] = [];
    faux.setResponses([
      () =>
        fauxAssistantMessage([fauxToolCall('find_tool', { query: 'arac139' })], { stopReason: 'toolUse' }),
      (ctx) => {
        const last = ctx.messages.at(-1) as { content: { text?: string }[] };
        found.push(last.content.map((c) => c.text ?? '').join(''));
        return fauxAssistantMessage(
          [fauxToolCall('use_tool', { name: 'uzak__arac139', arguments: { n: 1 } })],
          { stopReason: 'toolUse' },
        );
      },
      (ctx) => {
        const last = ctx.messages.at(-1) as { content: { text?: string }[] };
        found.push(last.content.map((c) => c.text ?? '').join(''));
        return fauxAssistantMessage('Tamam.');
      },
    ]);
    const own: AppTool = {
      name: 'hatirla',
      description: 'not al',
      input: {},
      readOnly: true,
      internal: true,
      handler: async () => '',
    };
    const app = (server: string, count: number): AppTool[] =>
      Array.from({ length: count }, (_, i) => ({
        name: `arac${i}`,
        description: `${server} aracı ${i}`,
        input: {},
        server,
        jsonSchema: { type: 'object', properties: { n: { type: 'number' } } },
        readOnly: true,
        internal: false,
        handler: async (args) => `${server} ${i} çalıştı ${JSON.stringify(args)}`,
      }));
    const watching = new PiEngine({
      sessionsDir: join(dir, 'sessions'),
      apiKey: async (p) => keys[p] ?? null,
      resolveModel: (p, id) => (p === 'deneme' ? faux.getModel(id) : undefined),
      streamFn: ((model, context, options) => {
        if (!names.length) {
          names = context.messages.flatMap((m) =>
            m.role === 'system' ? (m.toolsAdded ?? []).map((x: { name: string }) => x.name) : [],
          );
          system = context.messages
            .map((m) => (m.role === 'system' && typeof m.content === 'string' ? m.content : ''))
            .join('\n');
        }
        return streamSimple(model, context, options);
      }) as StreamFn,
    });
    const out = await watching.run(request({ tools: [...app('uzak', 140), ...app('kucuk', 3), own] }).req);
    expect(out).toMatchObject({ ok: true, text: 'Tamam.' });
    // The small app is listed whole; the big one is reached by search.
    expect(names).toContain('kucuk__arac2');
    expect(names).toContain('hatirla');
    expect(names).not.toContain('uzak__arac0');
    expect(names).toEqual(expect.arrayContaining(['find_tool', 'use_tool']));
    expect(names.length).toBeLessThanOrEqual(MAX_TOOLS);
    expect(system).toContain('find_tool');
    expect(found[0]).toContain('uzak__arac139');
    expect(found[1]).toContain('uzak 139 çalıştı {"n":1}');
    // The call asked as the tool itself, with its own arguments.
    expect(asks.at(-1)).toEqual({ toolName: 'mcp__uzak__arac139', input: { n: 1 } });
  });

  it('akıl yürüten modele botun düşünme seviyesini verir, ötekine vermez', async () => {
    const levels: unknown[] = [];
    const watching = new PiEngine({
      sessionsDir: join(dir, 'sessions'),
      apiKey: async (p) => keys[p] ?? null,
      resolveModel: (p, id) => (p === 'deneme' ? faux.getModel(id) : undefined),
      streamFn: ((model, context, options) => {
        levels.push(options?.reasoning);
        return streamSimple(model, context, options);
      }) as StreamFn,
    });
    faux.setResponses([fauxAssistantMessage('Tamam.'), fauxAssistantMessage('Tamam.')]);
    await watching.run(request({ model: 'deneme/dusunen', effort: 'high' }).req);
    await watching.run(request({ model: 'deneme/m1', effort: 'high' }).req);
    expect(levels[0]).toBe('high');
    expect(levels[1]).toBeUndefined();
  });

  it('duyurulan eylemi tanır, soruyu ve uzun yanıtı duyuru saymaz', () => {
    expect(announcesAction('Let me check the file:')).toBe(true);
    expect(announcesAction("I'll open the page now")).toBe(true);
    expect(announcesAction('Şimdi kontrol ediyorum')).toBe(true);
    expect(announcesAction('Hemen bakayım…')).toBe(true);
    expect(announcesAction('我先看看这个文件：')).toBe(true);
    expect(announcesAction('要我打开吗？')).toBe(false);
    expect(announcesAction('Dosyayı okuyayım mı?')).toBe(false);
    expect(announcesAction('Bitti, rapor hazır.')).toBe(false);
    expect(announcesAction(`Let me explain: ${'x'.repeat(400)}`)).toBe(false);
  });

  it('yerleşik listede olmayan modeli kişinin kendi uç noktasından alır', async () => {
    faux.setResponses([fauxAssistantMessage('Yerelden selam.')]);
    keys['custom-ev'] = 'none';
    const asked: string[] = [];
    const e = new PiEngine({
      sessionsDir: join(dir, 'sessions'),
      apiKey: async (p) => keys[p] ?? null,
      resolveModel: () => undefined,
      customModel: async (p, id) => {
        asked.push(`${p}/${id}`);
        return p === 'custom-ev' ? { ...faux.getModel('m1')!, provider: 'custom-ev', id } : undefined;
      },
      streamFn: ((model, context, options) =>
        streamSimple({ ...model, provider: 'deneme', id: 'm1' }, context, options)) as StreamFn,
    });
    const out = await e.run(request({ model: 'custom-ev/qwen3' }).req);
    expect(out).toMatchObject({ ok: true, text: 'Yerelden selam.' });
    expect(asked).toEqual(['custom-ev/qwen3']);
    expect(await e.run(request({ model: 'baska/qwen3' }).req)).toMatchObject({ ok: false });
  });

  it('klasör içindeki dosyayı izin sorarak yazar', async () => {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('write_file', { path: 'not.txt', content: 'içerik' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('Yazdım.'),
    ]);
    const { req } = request();
    const out = await engine().run(req);
    expect(out).toMatchObject({ ok: true, text: 'Yazdım.' });
    expect(readFileSync(join(cwd, 'not.txt'), 'utf8')).toBe('içerik');
    expect(asks).toHaveLength(1);
    expect(asks[0]!.toolName).toBe('Write');
    expect(String(asks[0]!.input.file_path)).toMatch(/not\.txt$/);
  });

  it('araç başlayıp bittiğinde ve her olayda canlılık işareti verir', async () => {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('write_file', { path: 'canli.txt', content: 'x' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('Yazdım.'),
    ]);
    const tools: string[] = [];
    let beats = 0;
    const { req } = request({
      onActivity: (tool) => {
        beats++;
        if (tool) tools.push(`${tool.running ? '+' : '-'}${tool.name}`);
      },
    });
    expect(await engine().run(req)).toMatchObject({ ok: true, text: 'Yazdım.' });
    expect(tools).toEqual(['+Write', '-Write']);
    expect(beats).toBeGreaterThan(tools.length);
  });

  it('görüntü dosyasını metin diye okumaz; görebilen modele görüntüyü gösterir', async () => {
    // A 1x1 PNG.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    writeFileSync(join(cwd, 'resim.png'), png);
    const seen: { type: string; data?: string; mimeType?: string; text?: string }[][] = [];
    const reply = (ctx: { messages: unknown[] }) => {
      seen.push((ctx.messages.at(-1) as { content: (typeof seen)[number] }).content);
      return fauxAssistantMessage('Gördüm.');
    };
    const call = () =>
      fauxAssistantMessage([fauxToolCall('read_file', { path: 'resim.png' })], { stopReason: 'toolUse' });
    faux.setResponses([call(), reply, call(), reply]);
    expect(await engine().run(request().req)).toMatchObject({ ok: true, text: 'Gördüm.' });
    const image = seen[0]!.find((c) => c.type === 'image')!;
    expect(image).toMatchObject({ mimeType: 'image/png', data: png.toString('base64') });

    // A model that cannot see pictures is told so, not handed the bytes as text.
    await engine().run(request({ model: 'deneme/metin' }).req);
    expect(seen[1]!.some((c) => c.type === 'image')).toBe(false);
    expect(seen[1]!.map((c) => c.text ?? '').join('')).toContain('görüntü göremiyor');
  });

  it('araç almayan modele araçsız istek gönderir', async () => {
    let names: string[] | null = null;
    faux.setResponses([fauxAssistantMessage('Merhaba.')]);
    const toolless = new PiEngine({
      sessionsDir: join(dir, 'sessions'),
      apiKey: async (p) => keys[p] ?? null,
      resolveModel: (p, id) => (p === 'deneme' ? faux.getModel(id) : undefined),
      takesTools: async () => false,
      streamFn: ((model, context, options) => {
        names = context.messages.flatMap((m) =>
          m.role === 'system' ? (m.toolsAdded ?? []).map((x: { name: string }) => x.name) : [],
        );
        return streamSimple(model, context, options);
      }) as StreamFn,
    });
    expect(await toolless.run(request().req)).toMatchObject({ ok: true, text: 'Merhaba.' });
    expect(names).toEqual([]);
  });

  it('reddedilen yazma yapılmaz, sonuç modele hata olarak döner', async () => {
    answer = { behavior: 'deny', message: 'Kullanıcı reddetti' };
    let toolResult = '';
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('write_file', { path: 'x.txt', content: 'y' })], {
        stopReason: 'toolUse',
      }),
      (ctx) => {
        const last = ctx.messages.at(-1) as { content: { type: string; text?: string }[] };
        toolResult = last.content.map((c) => c.text ?? '').join('');
        return fauxAssistantMessage('Tamam.');
      },
    ]);
    const out = await engine().run(request().req);
    expect(out.ok).toBe(true);
    expect(existsSync(join(cwd, 'x.txt'))).toBe(false);
    expect(toolResult).toContain('Kullanıcı reddetti');
  });

  it('klasör dışına ve bağlantı (symlink) üzerinden kaçışa izin vermez; izin bile sorulmaz', async () => {
    writeFileSync(join(outside, 'gizli.txt'), 'gizli');
    symlinkSync(outside, join(cwd, 'kacis'));
    const results: string[] = [];
    const capture = (ctx: { messages: unknown[] }) => {
      const last = ctx.messages.at(-1) as { content: { text?: string }[] };
      results.push(last.content.map((c) => c.text ?? '').join(''));
    };
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('read_file', { path: join(outside, 'gizli.txt') })], {
        stopReason: 'toolUse',
      }),
      (ctx) => {
        capture(ctx);
        return fauxAssistantMessage([fauxToolCall('read_file', { path: 'kacis/gizli.txt' })], {
          stopReason: 'toolUse',
        });
      },
      (ctx) => {
        capture(ctx);
        return fauxAssistantMessage(
          [fauxToolCall('write_file', { path: '../disari/yeni.txt', content: 'x' })],
          {
            stopReason: 'toolUse',
          },
        );
      },
      (ctx) => {
        capture(ctx);
        return fauxAssistantMessage('Olmadı.');
      },
    ]);
    const out = await engine().run(request().req);
    expect(out.ok).toBe(true);
    expect(asks).toHaveLength(0);
    expect(results).toHaveLength(3);
    for (const r of results) expect(r).not.toContain('gizli\n');
    expect(results.join(' ')).toMatch(/dışında|izni yok/);
    expect(existsSync(join(outside, 'yeni.txt'))).toBe(false);
  });

  it('hedefi olmayan bağlantı üzerinden klasör dışına dosya oluşturmaz', async () => {
    symlinkSync(join(outside, 'yok.txt'), join(cwd, 'link.txt'));
    symlinkSync(join(cwd, 'gercek.txt'), join(cwd, 'ic-link.txt'));
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('write_file', { path: 'link.txt', content: 'x' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage([fauxToolCall('write_file', { path: 'ic-link.txt', content: 'y' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('Olmadı.'),
    ]);
    answer = { behavior: 'allow' };
    const out = await engine().run(request().req);
    expect(out.ok).toBe(true);
    expect(existsSync(join(outside, 'yok.txt'))).toBe(false);
    // A link inside the folder is not followed either.
    expect(existsSync(join(cwd, 'gercek.txt'))).toBe(false);
  });

  it('adım sınırında turu durdurur', async () => {
    let calls = 0;
    const loop = () => {
      calls++;
      return fauxAssistantMessage([fauxToolCall('list_files', {})], { stopReason: 'toolUse' });
    };
    faux.setResponses(Array.from({ length: MAX_STEPS + 5 }, () => loop));
    const out = await engine().run(request().req);
    expect(out).toMatchObject({ ok: false, kind: 'engine' });
    expect(!out.ok && out.message).toContain('Adım sınırı');
    // The abort lands while the next request starts; that one is cut off.
    expect(calls).toBeLessThanOrEqual(MAX_STEPS + 1);
    expect(calls).toBeGreaterThanOrEqual(MAX_STEPS);
  });

  it('modeli kayıtlı anahtarla tek kısa istekle dener', async () => {
    faux.setResponses([fauxAssistantMessage('OK')]);
    expect(await engine().testModel('deneme/m1', 'tr')).toEqual({ ok: true });
    expect(faux.state.callCount).toBeGreaterThan(0);

    faux.setResponses([fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'Invalid API key' })]);
    expect(await engine().testModel('deneme/m1', 'tr')).toEqual({ ok: false, detail: 'Invalid API key' });

    expect((await engine().testModel('deneme/yok', 'tr')).ok).toBe(false);
    delete keys.deneme;
    const noKey = await engine().testModel('deneme/m1', 'tr');
    expect(noKey).toMatchObject({ ok: false, detail: expect.stringContaining('deneme') });
  });

  it('modeli denerken bir oturum kimliği verir; OpenCode onsuz isteği geri çevirir', async () => {
    const seen: (string | undefined)[] = [];
    const e = new PiEngine({
      sessionsDir: join(dir, 'sessions'),
      apiKey: async (p) => keys[p] ?? null,
      resolveModel: (p, id) => (p === 'deneme' ? faux.getModel(id) : undefined),
      complete: (async (_model, _context, options) => {
        seen.push(options?.sessionId);
        return fauxAssistantMessage('OK');
      }) as typeof completeSimple,
    });
    expect(await e.testModel('deneme/m1', 'tr')).toEqual({ ok: true });
    expect(await e.testModel('deneme/m1', 'tr')).toEqual({ ok: true });
    expect(seen[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen[1]).not.toBe(seen[0]);
  });

  it('geçmişi kullanıcı mesajında başlayacak şekilde kırpar', () => {
    const u = (n: number) => ({ role: 'user', content: `u${n}`, timestamp: n }) as never;
    const a = (n: number) => ({ role: 'assistant', content: [], n }) as never;
    const t = (n: number) => ({ role: 'toolResult', n }) as never;
    const sys = { role: 'system', content: 's' } as never;
    const msgs = [sys, u(1), a(1), t(1), a(2), u(2), a(3), t(2), a(4), u(3), a(5)];
    const out = trimHistory(msgs, 5);
    expect(out[0]).toBe(sys);
    expect(out.slice(1).map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
    expect(trimHistory(msgs, 50)).toBe(msgs);
  });

  it('istekte yalnız son üç görüntüyü bırakır; eskileri bir notla değiştirir, kayıtlı geçmişe dokunmaz', () => {
    const shot = (n: number) =>
      ({
        role: 'toolResult',
        content: [
          { type: 'text', text: `ekran ${n}` },
          { type: 'image', data: `veri${n}`, mimeType: 'image/jpeg' },
        ],
      }) as never;
    const msgs = [1, 2, 3, 4, 5].map(shot);
    const out = dropOldImages(msgs, '(eski)') as unknown as { content: { type: string; text?: string }[] }[];
    expect(out.map((m) => m.content.map((c) => c.type).join('+'))).toEqual([
      'text+text',
      'text+text',
      'text+image',
      'text+image',
      'text+image',
    ]);
    expect(out[0]!.content[1]!.text).toBe('(eski)');
    expect(out[0]!.content[0]!.text).toBe('ekran 1');
    // The messages saved to the session are left as they were.
    expect((msgs[0] as unknown as { content: { type: string }[] }).content[1]!.type).toBe('image');
  });

  it('salt okunur botta yazma aracı hiç verilmez', async () => {
    let names: string[] = [];
    faux.setResponses([
      (ctx) => {
        const sys = ctx.messages[0] as { toolsAdded?: { name: string }[] };
        names = (sys.toolsAdded ?? []).map((t) => t.name);
        return fauxAssistantMessage('ok');
      },
    ]);
    const { req } = request({
      sandbox: { cwd, additionalDirectories: [], writable: [], internet: true, readOnly: true },
    });
    await engine().run(req);
    expect(names).toEqual(expect.arrayContaining(['read_file', 'list_files', 'grep']));
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('edit_file');
  });

  it('uygulama araçlarını izin adıyla sorar ve çalıştırır', async () => {
    const calls: unknown[] = [];
    const tool: AppTool = {
      name: 'memory_search',
      description: 'ara',
      input: { query: z.string() },
      readOnly: true,
      internal: true,
      handler: async (args) => {
        calls.push(args);
        return 'bulundu';
      },
    };
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('memory_search', { query: 'kahve' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Buldum.'),
    ]);
    const out = await engine().run(request({ tools: [tool] }).req);
    expect(out.ok).toBe(true);
    expect(asks.map((a) => a.toolName)).toEqual(['mcp__yumakbot__memory_search']);
    expect(calls).toEqual([{ query: 'kahve' }]);
  });

  it('bağlantı araçlarını kendi adıyla, verilen JSON şemasıyla sunar', async () => {
    const calls: unknown[] = [];
    const schema = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] };
    const remote: AppTool = {
      name: 'search',
      server: 'notion',
      description: 'Notion araması',
      input: {},
      jsonSchema: schema,
      readOnly: true,
      internal: false,
      handler: async (args) => {
        calls.push(args);
        return 'sonuç';
      },
    };
    const own: AppTool = {
      name: 'bots_list',
      description: 'botlar',
      input: {},
      readOnly: true,
      internal: true,
      handler: async () => 'yok',
    };
    let seen: { name: string; parameters: unknown }[] = [];
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('notion__search', { q: 'plan' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Tamam.'),
    ]);
    const watching = new PiEngine({
      sessionsDir: join(dir, 'sessions'),
      apiKey: async (p) => keys[p] ?? null,
      resolveModel: (p, id) => (p === 'deneme' ? faux.getModel(id) : undefined),
      streamFn: ((model, context, options) => {
        seen = context.messages
          .flatMap((m) => (m.role === 'system' ? (m.toolsAdded ?? []) : []))
          .map((x) => ({ name: x.name, parameters: x.parameters }));
        return streamSimple(model, context, options);
      }) as StreamFn,
    });
    const out = await watching.run(request({ tools: [remote, own] }).req);
    expect(out.ok).toBe(true);
    expect(seen.find((x) => x.name === 'notion__search')?.parameters).toEqual(schema);
    // The app's own tools keep their Zod-made schema.
    expect(seen.find((x) => x.name === 'bots_list')?.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
    expect(asks.map((a) => a.toolName)).toEqual(['mcp__notion__search']);
    expect(calls).toEqual([{ q: 'plan' }]);
  });

  it('anahtar yoksa ya da model biçimi yanlışsa açık bir hata verir', async () => {
    keys = {};
    const noKey = await engine().run(request().req);
    expect(noKey).toMatchObject({ ok: false, kind: 'engine' });
    expect(!noKey.ok && noKey.message).toContain('API anahtarı yok');

    const bad = await engine().run(request({ model: 'sonnet' }).req);
    expect(!bad.ok && bad.message).toContain('sağlayıcı/model');

    const unknown = await engine().run(request({ model: 'yok/m9' }).req);
    expect(!unknown.ok && unknown.message).toContain('Model bulunamadı');
  });

  it('model hatasında geçmişi bozmaz', async () => {
    faux.setResponses([fauxAssistantMessage('ilk')]);
    const first = await engine().run(request().req);
    faux.setResponses([
      fauxAssistantMessage([fauxText('')], { stopReason: 'error', errorMessage: '429 çok fazla istek' }),
    ]);
    const failed = await engine().run(request({ sessionId: first.sessionId }).req);
    expect(failed).toMatchObject({ ok: false, kind: 'limit', provider: 'deneme' });
    expect(!failed.ok && failed.message).toContain('429');
    const saved = JSON.parse(readFileSync(join(dir, 'sessions', `${first.sessionId}.json`), 'utf8'));
    expect(saved.messages).toHaveLength(2);
  });

  it('durdurulunca yarıda keser', async () => {
    const { req, ctrl } = request();
    faux.setResponses([
      async () => {
        ctrl.abort();
        await new Promise((r) => setTimeout(r, 20));
        return fauxAssistantMessage('geç kaldı');
      },
    ]);
    const out = await engine().run(req);
    expect(out).toMatchObject({ ok: false, kind: 'interrupted' });
  });
});

describe('motor değişimi', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  it('bot motor değiştirince eski oturumlar devam ettirilmez', async () => {
    const bot = await t.bot({ name: 'Değişken' });
    const thread = (await t.api<{ id: string }>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await t.services.threads.setSession(thread.id, '11111111-2222-3333-4444-555555555555');
    await t.api('PATCH', `/api/bots/${bot.id}`, { model: 'opus' });
    expect((await t.services.threads.row(thread.id)).engineSessionId).not.toBeNull();
    await t.api('PATCH', `/api/bots/${bot.id}`, { engine: 'pi', model: 'openai/gpt-4o-mini' });
    expect((await t.services.threads.row(thread.id)).engineSessionId).toBeNull();
  });
});

describe('sağlayıcı anahtarları', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  it('anahtarı saklar ama API yalnızca ipucunu döndürür', async () => {
    const put = await t.api('PUT', '/api/providers/openai/key', { key: 'sk-test-abcdefgh1234' });
    expect(put.status).toBe(200);
    const list = await t.api<ProviderInfo[]>('GET', '/api/providers');
    const openai = list.body.find((p) => p.id === 'openai')!;
    expect(openai).toEqual({ id: 'openai', configured: true, hint: '…1234' });
    expect(JSON.stringify(list.body)).not.toContain('abcdefgh');
    expect(await t.services.keys.get('openai')).toBe('sk-test-abcdefgh1234');
    // Settings never include secrets.
    expect(JSON.stringify((await t.api('GET', '/api/settings')).body)).not.toContain('sk-test');

    expect((await t.api('DELETE', '/api/providers/openai/key')).status).toBe(200);
    expect(await t.services.keys.get('openai')).toBeNull();
  });

  it('abonelik jetonlarını ve bilinmeyen sağlayıcıları reddeder', async () => {
    const oat = await t.api('PUT', '/api/providers/anthropic/key', { key: 'sk-ant-oat01-xxxxxxxxxxxx' });
    expect(oat.status).toBe(400);
    expect((await t.api('PUT', '/api/providers/uydurma/key', { key: 'abcdefghijk' })).status).toBe(404);
    expect((await t.api('PUT', '/api/providers/github-copilot/key', { key: 'abcdefghijk' })).status).toBe(
      404,
    );
    const models = await t.api<string[]>('GET', '/api/providers/openai/models');
    expect(models.body.length).toBeGreaterThan(0);
  });

  it('modeli denemeden önce anahtarı ve modeli doğrular', async () => {
    const [model] = (await t.api<string[]>('GET', '/api/providers/openai/models')).body;
    const before = await t.api('POST', '/api/providers/openai/test', { model });
    expect(before.status).toBe(400);
    await t.api('PUT', '/api/providers/openai/key', { key: 'sk-test-abcdefgh1234' });
    expect((await t.api('POST', '/api/providers/openai/test', { model })).body).toEqual({ ok: true });
    // A model the catalog does not list yet is tried as well; the request tells whether it exists.
    expect((await t.api('POST', '/api/providers/openai/test', { model: 'yeni-cikan-model' })).body).toEqual({
      ok: true,
    });
    expect((await t.api('POST', '/api/providers/openai/test', { model: 'hata-model' })).body).toMatchObject({
      ok: false,
    });
    expect((await t.api('POST', '/api/providers/uydurma/test', { model })).status).toBe(404);
  });

  it('katalogda olmayan modeli sağlayıcının en benzer modelinin ayarlarıyla kurar', async () => {
    const listed = (await t.api<string[]>('GET', '/api/providers/openai/models')).body;
    const base = listed.find((m) => m.startsWith('gpt-'))!;
    const made = await t.services.keys.customModel('openai', `${base}-yeni`);
    expect(made).toMatchObject({
      id: `${base}-yeni`,
      name: `${base}-yeni`,
      provider: 'openai',
      cost: { input: 0, output: 0 },
    });
    expect(made?.api).toBeTruthy();
    expect(made?.baseUrl).toMatch(/^https:/);
    // Subscription-only and unknown providers are not given made-up models.
    expect(await t.services.keys.customModel('github-copilot', 'gpt-x')).toBeUndefined();
    expect(await t.services.keys.customModel('uydurma', 'gpt-x')).toBeUndefined();
  });

  it('anahtarı kasa anahtarıyla şifreli saklar; eski düz anahtarı okurken şifreler', async () => {
    await t.api('PUT', '/api/providers/openai/key', { key: 'sk-test-abcdefgh1234' });
    const stored = async (k: string) =>
      String((await t.db.db.select().from(schema.kv).where(eq(schema.kv.key, k)))[0]?.value);
    expect(await stored('secret.apikey.openai')).toMatch(/^v1:/);
    expect(await stored('secret.apikey.openai')).not.toContain('abcdefgh');

    await t.db.db.insert(schema.kv).values({ key: 'secret.apikey.groq', value: 'gsk-eski-duz-anahtar' });
    expect(await t.services.keys.get('groq')).toBe('gsk-eski-duz-anahtar');
    expect(await stored('secret.apikey.groq')).toMatch(/^v1:/);
    const groq = (await t.api<ProviderInfo[]>('GET', '/api/providers')).body.find((p) => p.id === 'groq');
    expect(groq?.hint).toBe('…htar');
  });

  describe('kendi uç noktası', () => {
    let server: Server;
    let base: string;
    let auth: (string | undefined)[];
    beforeEach(async () => {
      auth = [];
      server = createServer((req, res) => {
        if (req.url !== '/v1/models') return void res.writeHead(404).end();
        auth.push(req.headers.authorization);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [
              { id: 'qwen3', context_length: 32_768, top_provider: { max_completion_tokens: 4_096 } },
              { id: 'llama3', max_model_len: 8_192, architecture: { input_modalities: ['text', 'image'] } },
              { id: 'qwen3' },
            ],
          }),
        );
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    });
    afterEach(() => new Promise<void>((r) => server.close(() => r())));

    it('Ollama sunucusunu tanır: gömme modellerini listelemez, araç almayan modeli işaretler', async () => {
      const ollama = createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        if (req.url === '/v1/models') {
          return res.end(JSON.stringify({ data: [{ id: 'qwen3' }, { id: 'nomic-embed' }, { id: 'kucuk' }] }));
        }
        if (req.url === '/api/version') return res.end(JSON.stringify({ version: '0.9.0' }));
        if (req.url === '/api/show') {
          let body = '';
          req.on('data', (c: Buffer) => (body += c.toString()));
          return req.on('end', () => {
            const model = (JSON.parse(body) as { model: string }).model;
            const caps = {
              qwen3: ['completion', 'tools'],
              'nomic-embed': ['embedding'],
              kucuk: ['completion', 'vision'],
            };
            res.end(JSON.stringify({ capabilities: caps[model as keyof typeof caps] }));
          });
        }
        res.writeHead(404).end();
      });
      await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', r));
      try {
        const url = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}/v1`;
        const add = await t.api<ProviderInfo>('POST', '/api/providers/custom', {
          name: 'Ollama',
          baseUrl: url,
        });
        expect(add.status).toBe(200);
        const models = (await t.api<string[]>('GET', `/api/providers/${add.body.id}/models`)).body;
        expect(models).toEqual(['kucuk', 'qwen3']);
        expect(await t.services.keys.takesTools(add.body.id, 'qwen3')).toBe(true);
        expect(await t.services.keys.takesTools(add.body.id, 'kucuk')).toBe(false);
      } finally {
        await new Promise<void>((r) => ollama.close(() => r()));
      }
    });

    it('anahtarı düz http ile başka bir bilgisayara göndermez', async () => {
      const r = await t.api<{ message: string }>('POST', '/api/providers/custom', {
        name: 'Uzak',
        baseUrl: 'http://192.168.1.20:11434/v1',
        key: 'sk-uzak-12345678',
      });
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.body)).toContain('https');
    });

    it('modellerini sorar, sağlayıcılar arasında listelenir ve silinebilir', async () => {
      const add = await t.api<ProviderInfo>('POST', '/api/providers/custom', {
        name: 'Evdeki Ollama',
        baseUrl: `${base}/`,
        key: 'sk-yerel-12345678',
      });
      expect(add.status).toBe(200);
      expect(add.body).toEqual({
        id: 'custom-evdeki-ollama',
        configured: true,
        hint: '…5678',
        custom: { name: 'Evdeki Ollama', baseUrl: base },
      });
      expect(auth).toEqual(['Bearer sk-yerel-12345678']);
      const models = await t.api<string[]>('GET', '/api/providers/custom-evdeki-ollama/models');
      expect(models.body).toEqual(['llama3', 'qwen3']);
      expect(await t.services.keys.customModel('custom-evdeki-ollama', 'qwen3')).toMatchObject({
        api: 'openai-completions',
        baseUrl: base,
        provider: 'custom-evdeki-ollama',
        contextWindow: 32_768,
        maxTokens: 4_096,
        input: ['text'],
      });
      // A small window leaves room for the input; a model that takes pictures says so.
      expect(await t.services.keys.customModel('custom-evdeki-ollama', 'llama3')).toMatchObject({
        contextWindow: 8_192,
        maxTokens: 2_048,
        input: ['text', 'image'],
      });
      expect(
        (await t.api('POST', '/api/providers/custom-evdeki-ollama/test', { model: 'qwen3' })).body,
      ).toEqual({
        ok: true,
      });

      // A second one by the same name gets its own id; one with no key still counts as usable.
      const again = await t.api<ProviderInfo>('POST', '/api/providers/custom', {
        name: 'Evdeki Ollama',
        baseUrl: base,
      });
      expect(again.body.id).toBe('custom-evdeki-ollama-2');
      expect(await t.services.keys.credential('custom-evdeki-ollama-2')).toBe('none');
      expect(await t.services.keys.credential('openai')).toBeNull();

      expect((await t.api('DELETE', '/api/providers/custom-evdeki-ollama')).status).toBe(200);
      const ids = (await t.api<ProviderInfo[]>('GET', '/api/providers')).body.map((p) => p.id);
      expect(ids).not.toContain('custom-evdeki-ollama');
      expect(await t.services.keys.get('custom-evdeki-ollama')).toBeNull();
    });

    it('bilgisayarda çalışan model sunucularını bulur; eklenmiş olanı yeniden önermez', async () => {
      const candidates = [
        { name: 'Yerel', baseUrl: base },
        { name: 'Kapalı', baseUrl: 'http://127.0.0.1:9/v1' },
      ];
      expect(await t.services.keys.discover(candidates)).toEqual([
        { name: 'Yerel', baseUrl: base, models: ['llama3', 'qwen3'] },
      ]);
      await t.api('POST', '/api/providers/custom', { name: 'Yerel', baseUrl: base });
      expect(await t.services.keys.discover(candidates)).toEqual([]);
      // No key goes out in a probe.
      expect(auth.every((a) => a === undefined)).toBe(true);
      expect((await t.api('GET', '/api/providers/discover')).status).toBe(200);
    });

    it('kayıtlı uç nokta düzenlenir; boş anahtar eskisini korur, yeni adres modelleri yeniden sorar', async () => {
      const add = await t.api<ProviderInfo>('POST', '/api/providers/custom', {
        name: 'Yerel',
        baseUrl: `${base}/yok`,
        key: 'sk-eski-12345678',
        models: ['elle'],
      });
      const id = add.body.id;
      const renamed = await t.api<ProviderInfo>('PATCH', `/api/providers/${id}`, {
        name: 'Ev sunucusu',
        key: '',
      });
      expect(renamed.body).toMatchObject({ custom: { name: 'Ev sunucusu' }, hint: '…5678' });
      const moved = await t.api<ProviderInfo>('PATCH', `/api/providers/${id}`, {
        baseUrl: base,
        key: 'sk-yeni-87654321',
      });
      expect(moved.body).toMatchObject({ custom: { baseUrl: base }, hint: '…4321' });
      expect(auth.at(-1)).toBe('Bearer sk-yeni-87654321');
      expect((await t.api<string[]>('GET', `/api/providers/${id}/models`)).body).toEqual(['llama3', 'qwen3']);
      expect((await t.api('PATCH', `/api/providers/${id}`, { baseUrl: `${base}/yok` })).status).toBe(400);

      // A model the server leaves out is named by hand; an empty list keeps the saved one.
      await t.api('PATCH', `/api/providers/${id}`, { models: ['qwen3', 'elle-eklenen', 'qwen3'] });
      expect((await t.api<string[]>('GET', `/api/providers/${id}/models`)).body).toEqual([
        'qwen3',
        'elle-eklenen',
      ]);
      await t.api('PATCH', `/api/providers/${id}`, { name: 'Ev', models: [] });
      expect((await t.api<string[]>('GET', `/api/providers/${id}/models`)).body).toEqual([
        'qwen3',
        'elle-eklenen',
      ]);
      // A model typed for the endpoint is tried even when it is on no list.
      expect((await t.api('POST', `/api/providers/${id}/test`, { model: 'listede-yok' })).body).toEqual({
        ok: true,
      });
    });

    it('model listesi alınamazsa modellerin elle yazılmasını ister', async () => {
      const bad = await t.api<{ error: string }>('POST', '/api/providers/custom', {
        name: 'Uzak',
        baseUrl: `${base}/yok`,
      });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toContain('HTTP 404');
      const typed = await t.api<ProviderInfo>('POST', '/api/providers/custom', {
        name: 'Uzak',
        baseUrl: `${base}/yok`,
        models: ['benim-modelim'],
      });
      expect(typed.status).toBe(200);
      expect((await t.api<string[]>('GET', `/api/providers/${typed.body.id}/models`)).body).toEqual([
        'benim-modelim',
      ]);
      expect(
        (await t.api('POST', '/api/providers/custom', { name: 'X', baseUrl: 'file:///etc' })).status,
      ).toBe(400);
      expect(endpointUrl('http://kisi:sifre@yerel/v1')).toBeNull();
      // A key travels over plain http only to this computer.
      expect(keySafeAt('https://openrouter.ai/api/v1')).toBe(true);
      expect(keySafeAt('http://127.0.0.1:11434/v1')).toBe(true);
      expect(keySafeAt('http://localhost:1234/v1')).toBe(true);
      expect(keySafeAt('http://[::1]:8080/v1')).toBe(true);
      expect(keySafeAt('http://192.168.1.20:11434/v1')).toBe(false);
      expect(keySafeAt('http://gateway.example.com/v1')).toBe(false);
      expect(endpointUrl('https://openrouter.ai/api/v1/?x=1')).toBe('https://openrouter.ai/api/v1');
    });
  });

  it('yeni botların motoru ve diğer sağlayıcı modeli ayarlarda saklanır', async () => {
    const s0 = await t.api<{ defaultEngine: string; piModel: string }>('GET', '/api/settings');
    expect(s0.body).toMatchObject({ defaultEngine: 'claude', piModel: '' });
    const ok = await t.api('PATCH', '/api/settings', { defaultEngine: 'pi', piModel: 'openai/gpt-4o-mini' });
    expect(ok.status).toBe(200);
    expect((await t.api('GET', '/api/settings')).body).toMatchObject({
      defaultEngine: 'pi',
      piModel: 'openai/gpt-4o-mini',
    });
    expect((await t.api('PATCH', '/api/settings', { piModel: 'modelsiz' })).status).toBe(400);
    expect((await t.api('PATCH', '/api/settings', { defaultEngine: 'gpt' })).status).toBe(400);
  });
});

describe('OpenCode oturum başlığı', () => {
  it('oturum kimliği verilen istek x-opencode-session başlığıyla gider', async () => {
    const headers: (string | string[] | undefined)[] = [];
    const server = createServer((req, res) => {
      headers.push(req.headers['x-opencode-session']);
      res.writeHead(500, { 'content-type': 'application/json' }).end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const listed = getModels('opencode-go' as never) as Model<string>[];
      const model = { ...listed[0]!, baseUrl: base };
      await completeSimple(model, { messages: [{ role: 'user', content: 'OK?', timestamp: Date.now() }] }, {
        apiKey: 'test-anahtar',
        maxTokens: 8,
        sessionId: 'oturum-1',
        maxRetries: 0,
      } as never);
      expect(headers[0]).toBe('oturum-1');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('katalogda olmayan model', () => {
  const model = (id: string, api: string) =>
    ({
      id,
      name: id,
      api,
      provider: 'p',
      baseUrl: `https://${api}.example`,
      reasoning: false,
      input: ['text'],
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 100,
    }) as Model<string>;
  const listed = [model('claude-opus-5', 'anthropic-messages'), model('gpt-6-sol', 'openai-responses')];

  it('adı en çok benzeyen modelin API ve adresini alır, fiyatı bilinmez sayar', () => {
    expect(unlistedModel(listed, 'gpt-6.2')).toMatchObject({
      id: 'gpt-6.2',
      api: 'openai-responses',
      baseUrl: 'https://openai-responses.example',
      cost: { input: 0, output: 0 },
    });
    expect(unlistedModel(listed, 'claude-opus-6')).toMatchObject({ api: 'anthropic-messages' });
    // Nothing alike: the first listed model stands in.
    expect(unlistedModel(listed, 'zzz')?.api).toBe('anthropic-messages');
    expect(unlistedModel([], 'gpt-6.2')).toBeUndefined();
  });
});

describe('sağlayıcı hataları', () => {
  const t = translator('tr');
  it('anahtar, bakiye, sınır, yoğunluk ve erişim hatalarını açıklar', () => {
    expect(providerTrouble('401 Unauthorized: invalid api key', 'openai', t)).toMatchObject({
      kind: 'engine',
    });
    expect(providerTrouble('401 Unauthorized', 'openai', t).message).toContain('API anahtarını kabul etmedi');
    expect(providerTrouble('402 Insufficient credits', 'openrouter', t).message).toContain('bakiye');
    expect(providerTrouble('413 Request Entity Too Large', 'openai', t)).toMatchObject({
      kind: 'engine',
      message: expect.stringContaining('çok büyük'),
    });
    expect(CONTEXT_FULL.test(providerTrouble('413 Payload Too Large', 'openai', t).message)).toBe(true);
    expect(providerTrouble('429 Too Many Requests', 'groq', t)).toMatchObject({ kind: 'limit' });
    expect(providerTrouble('503 Service Unavailable', 'groq', t)).toMatchObject({ transient: true });
    expect(providerTrouble('fetch failed: ECONNREFUSED', 'custom-ev', t).message).toContain('ulaşılamadı');
    expect(providerTrouble('strange', 'x', t)).toEqual({ kind: 'engine', message: 'strange' });
  });
});
