import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
  type FauxProviderRegistration,
} from '@earendil-works/pi-ai/compat';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { PiEngine } from '../src/engine/pi';
import { pageUrl, readableText, webTools } from '../src/engine/pi-web';
import type { PermissionAsk, TurnRequest } from '../src/engine/types';
import { translator } from '../src/i18n';
import type { fetchPublic } from '../src/services/skill-link';

const t = translator('tr');
const mark = (source: string, text: string) => `[${source}]\n${text}`;

/** A page as the public fetch would hand it back. */
const served =
  (body: string, contentType = 'text/html; charset=utf-8', final?: string): typeof fetchPublic =>
  async (url) => ({ body: Buffer.from(body), contentType, url: final ? new URL(final) : url });

const tool = (name: string, o: Parameters<typeof webTools>[1]) =>
  webTools(t, o).find((x) => x.name === name)!;
const signal = new AbortController().signal;

describe('sayfa metni', () => {
  it('ana bölümü, başlıkları, listeleri ve tam adresli bağlantıları verir; betik ve menü yok', () => {
    const html = `<html><head><title>Haber &amp; Yorum</title><style>p{}</style></head><body>
      <nav><a href="/menu">Menü</a></nav>
      <main><h1>Başlık</h1><p>İlk paragraf ${'uzun metin '.repeat(30)}</p>
      <ul><li>bir</li><li>iki &#8211; üç</li></ul>
      <p>Bkz. <a href="/devam?x=1&amp;y=2">devamı</a></p>
      <script>alert(1)</script></main><footer>Alt bilgi</footer></body></html>`;
    const text = readableText(html, new URL('https://ornek.com/haber/1'));
    expect(text).toContain('# Haber & Yorum');
    expect(text).toContain('# Başlık');
    expect(text).toContain('- bir\n- iki – üç');
    expect(text).toContain('[devamı](https://ornek.com/devam?x=1&y=2)');
    expect(text).not.toMatch(/alert|Menü|Alt bilgi|p\{\}/);
  });

  it('http adresini https okur; başka şemayı ve kullanıcı adlı adresi geri çevirir', () => {
    expect(pageUrl('http://ornek.com/a#b', t).href).toBe('https://ornek.com/a');
    expect(() => pageUrl('ftp://ornek.com', t)).toThrow(t('web.badUrl'));
    expect(() => pageUrl('https://ben:sifre@ornek.com', t)).toThrow(t('web.badUrl'));
    expect(() => pageUrl('ornek', t)).toThrow(t('web.badUrl'));
  });
});

describe('web_fetch', () => {
  it('sayfayı okunur metin olarak, dışarıdan gelen veri diye işaretleyerek verir', async () => {
    const fetchPage = served('<body><p>Merhaba dünya</p></body>', 'text/html', 'https://ornek.com/son');
    const out = await tool('web_fetch', { mark, fetchPage }).run({ url: 'http://ornek.com/ilk' }, signal);
    expect(out).toBe('[ornek.com]\nhttps://ornek.com/ilk → https://ornek.com/son\n\nMerhaba dünya');
  });

  it('metin olmayanı okumaz; JSON olduğu gibi gelir', async () => {
    const pdf = await tool('web_fetch', { mark, fetchPage: served('%PDF', 'application/pdf') }).run(
      { url: 'https://ornek.com/a.pdf' },
      signal,
    );
    expect(pdf).toBe(t('web.notText', { type: 'application/pdf' }));
    const json = await tool('web_fetch', { mark, fetchPage: served('{"a":1}', 'application/json') }).run(
      { url: 'https://ornek.com/a.json' },
      signal,
    );
    expect(json).toContain('{"a":1}');
  });

  it('bu bilgisayarı ya da özel ağı gösteren adresi izin sormadan geri çevirir', async () => {
    const web = tool('web_fetch', { mark });
    for (const url of ['https://localhost/a', 'https://127.0.0.1/', 'http://10.0.0.5/', 'https://[::1]/'])
      await expect(web.check!({ url })).rejects.toThrow(t('web.private'));
  });
});

describe('web_search', () => {
  const searx = (status: number, body: unknown) => {
    const calls: URL[] = [];
    const fn = (async (url: URL) => {
      calls.push(new URL(url));
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return { fn, calls };
  };

  it('yalnızca bir arama adresi verilince sunulur', () => {
    expect(webTools(t, { mark }).map((x) => x.name)).toEqual(['web_fetch']);
    expect(webTools(t, { mark, searchUrl: 'http://searx:8080' }).map((x) => x.permissionName)).toEqual([
      'WebFetch',
      'WebSearch',
    ]);
  });

  it('SearXNG’den JSON ister; sonuçları başlık, adres ve özetle, tekrarsız verir', async () => {
    const { fn, calls } = searx(200, {
      answers: ['42'],
      results: [
        { url: 'https://a.com/1', title: 'Bir', content: 'ilk  özet', publishedDate: '2026-11-01T10:00:00' },
        { url: 'https://a.com/1', title: 'Bir (yine)' },
        { url: 'javascript:alert(1)', title: 'Kötü' },
        { url: 'https://b.com/2', title: '', content: '' },
        { url: 'https://c.com/3', title: 'Üç' },
      ],
    });
    const search = tool('web_search', { mark, searchUrl: 'http://searx:8080/', searchFetch: fn });
    const out = await search.run({ query: 'hayatın anlamı', count: 2 }, signal);
    expect(calls[0]!.href).toBe(
      'http://searx:8080/search?q=hayat%C4%B1n+anlam%C4%B1&format=json&safesearch=1',
    );
    expect(out).toBe(
      [
        `[${t('web.searchSource')}]`,
        'Yanıt: 42',
        '1. Bir (2026-11-01)\n   https://a.com/1\n   ilk özet',
        '2. https://b.com/2\n   https://b.com/2',
      ].join('\n'),
    );
  });

  it('JSON kapalıysa ne yapılacağını, sonuç yoksa bunu söyler', async () => {
    const closed = tool('web_search', { mark, searchUrl: 'http://searx', searchFetch: searx(403, {}).fn });
    await expect(closed.run({ query: 'x' }, signal)).rejects.toThrow(t('web.searchNoJson'));
    const none = tool('web_search', {
      mark,
      searchUrl: 'http://searx',
      searchFetch: searx(200, { results: [] }).fn,
    });
    expect(await none.run({ query: 'x' }, signal)).toBe(t('web.noResults', { query: 'x' }));
  });

  it('adres ortamdaki WEB_SEARCH_URL’den gelir; geçersiz adres yok sayılır', () => {
    expect(loadConfig({ WEB_SEARCH_URL: 'http://searxng-1:8080/' }).webSearchUrl).toBe(
      'http://searxng-1:8080',
    );
    expect(loadConfig({ WEB_SEARCH_URL: 'searxng' }).webSearchUrl).toBeNull();
    expect(loadConfig({}).webSearchUrl).toBeNull();
  });
});

let faux: FauxProviderRegistration;
beforeAll(() => {
  faux = registerFauxProvider({ provider: 'webdeneme', models: [{ id: 'm1' }], tokensPerSecond: 0 });
});

describe('Pi motorunda web araçları', () => {
  let dir: string;
  let cwd: string;
  let asks: PermissionAsk[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'leafbot-piweb-'));
    cwd = join(dir, 'thread');
    mkdirSync(cwd);
    asks = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const engine = () =>
    new PiEngine({
      sessionsDir: join(dir, 'sessions'),
      apiKey: async () => 'anahtar',
      resolveModel: (p, id) => (p === 'webdeneme' ? faux.getModel(id) : undefined),
      webSearchUrl: 'http://searx',
      web: { fetchPage: served('<p>Sayfa metni</p>') },
    });
  const request = (internet: boolean): TurnRequest => ({
    turnId: 't1',
    threadId: 'th1',
    botId: 'b1',
    model: 'webdeneme/m1',
    prompt: 'oku',
    sessionId: null,
    systemPrompt: 'Test.',
    locale: 'tr',
    sandbox: { cwd, additionalDirectories: [], writable: [cwd], internet, readOnly: false },
    shell: 'sandbox',
    tools: [],
    canUseTool: async (ask) => {
      asks.push(ask);
      return { behavior: 'allow' };
    },
    onText: () => {},
    onSession: () => {},
    signal: new AbortController().signal,
  });

  it('sayfayı Claude’un adıyla (WebFetch) sorar ve okur; özel adres için sormaz', async () => {
    let seen = '';
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('web_fetch', { url: 'https://127.0.0.1/gizli' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage([fauxToolCall('web_fetch', { url: 'https://example.com/' })], {
        stopReason: 'toolUse',
      }),
      (ctx) => {
        seen = JSON.stringify(ctx.messages.at(-1));
        return fauxAssistantMessage('Okudum.');
      },
    ]);
    expect(await engine().run(request(true))).toMatchObject({ ok: true, text: 'Okudum.' });
    expect(asks).toEqual([{ toolName: 'WebFetch', input: { url: 'https://example.com/' } }]);
    expect(seen).toContain('Sayfa metni');
    expect(seen).toContain('outside-data');
  });

  it('internet kapalıyken web araçları hiç sunulmaz', async () => {
    let names: string[] = [];
    faux.setResponses([
      (ctx) => {
        names = ((ctx.messages[0] as { toolsAdded?: { name: string }[] }).toolsAdded ?? []).map(
          (x) => x.name,
        );
        return fauxAssistantMessage('Tamam.');
      },
    ]);
    await engine().run(request(false));
    expect(names).toContain('read_file');
    expect(names).not.toContain('web_fetch');
    expect(names).not.toContain('web_search');
    faux.setResponses([
      (ctx) => {
        names = ((ctx.messages[0] as { toolsAdded?: { name: string }[] }).toolsAdded ?? []).map(
          (x) => x.name,
        );
        return fauxAssistantMessage('Tamam.');
      },
    ]);
    await engine().run(request(true));
    expect(names).toEqual(expect.arrayContaining(['web_fetch', 'web_search']));
  });
});
