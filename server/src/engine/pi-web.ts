import { z } from 'zod';
import type { T } from '../i18n';
import { fetchPublic, publicHost, type PublicFetchOptions } from '../services/skill-link';
import { hiddenInHtml, plantedIn } from '../runtime/hidden-text';
import { HttpError } from '../util';
import { PathError, type FileTool } from './pi-files';
import type { ToolResult } from './types';

/** The most of a page read; a larger one is refused rather than cut mid-byte. */
const PAGE_MAX = 5 * 1024 * 1024;
/** The most of a page's text handed to the model; the conversation's own cap may cut further. */
const TEXT_MAX = 80_000;
const FETCH_TIMEOUT_MS = 20_000;
const REDIRECTS = 5;
/** Sites that turn away a bare client usually let a browser-like one in. */
const USER_AGENT = 'Mozilla/5.0 (compatible; LeafBot/1.0)';
const SEARCH_TIMEOUT_MS = 15_000;
const SEARCH_DEFAULT = 8;
const SEARCH_MAX = 20;
const SNIPPET_MAX = 400;

/** Types read as text as they are. */
const TEXT_TYPES = /^(?:text\/|application\/(?:json|xml|[\w.+-]+\+(?:json|xml)|javascript|x-yaml|yaml))/i;

/** The tag outside text is wrapped in, as the system prompt explains it. */
type Mark = (source: string, text: string) => string;

export interface WebToolOptions {
  /** A SearXNG address the server's environment names; without one there is no search. */
  searchUrl?: string | null;
  /** Marks text from outside as data, not instructions. */
  mark: Mark;
  /** Tests pass a stand-in for reading a page and for the search service. */
  fetchPage?: typeof fetchPublic;
  fetchOptions?: PublicFetchOptions;
  searchFetch?: typeof fetch;
}

/** The web tools for API-key models; withheld when the bot's internet is off. */
export function webTools(t: T, o: WebToolOptions): FileTool[] {
  const tools: FileTool[] = [webFetch(t, o)];
  if (o.searchUrl) tools.push(webSearch(t, o.searchUrl, o));
  return tools;
}

/** The address the model gave, as one the page is read from: http goes as https. */
export function pageUrl(raw: unknown, t: T): URL {
  let url: URL;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new PathError(t('web.badUrl'));
  }
  if (url.protocol === 'http:') url.protocol = 'https:';
  if (url.protocol !== 'https:') throw new PathError(t('web.badUrl'));
  if (url.username || url.password) throw new PathError(t('web.badUrl'));
  url.hash = '';
  return url;
}

function webFetch(t: T, o: WebToolOptions): FileTool {
  const read = o.fetchPage ?? fetchPublic;
  return {
    name: 'web_fetch',
    permissionName: 'WebFetch',
    description: t('web.fetch'),
    input: { url: z.string().min(1).max(4000).describe(t('web.fetchUrl')) },
    target: (a) => pageUrl(a.url, t).href,
    // An address on this machine or the private network is never read: no card for it.
    async check(a) {
      if (!(await publicHost(pageUrl(a.url, t).hostname))) throw new PathError(t('web.private'));
    },
    cardInput: (_a, href) => ({ url: href }),
    async run(a): Promise<ToolResult> {
      const url = pageUrl(a.url, t);
      let page;
      try {
        page = await read(url, PAGE_MAX, {
          redirects: REDIRECTS,
          timeoutMs: FETCH_TIMEOUT_MS,
          userAgent: USER_AGENT,
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
          ...o.fetchOptions,
        });
      } catch (err) {
        throw new PathError(fetchError(err, t));
      }
      const type = page.contentType.split(';')[0]!.trim().toLowerCase();
      const raw = pageChars(page.body, page.contentType);
      let text: string;
      // Text the markup hides from people but that speaks to an agent: the bot is told before it reads.
      let planted: string[] = [];
      if (!type || type === 'text/html' || type === 'application/xhtml+xml') {
        text = readableText(raw, page.url);
        planted = plantedIn(hiddenInHtml(raw));
      } else if (TEXT_TYPES.test(type)) text = raw;
      else return t('web.notText', { type });
      const cut = text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX)}\n${t('web.cut')}` : text;
      const head = page.url.href === url.href ? page.url.href : `${url.href} → ${page.url.href}`;
      const warn = planted.length
        ? `${t('browser.planted', { site: page.url.hostname, quotes: planted.map((q) => `"${q}"`).join('; ') })}\n\n`
        : '';
      return o.mark(page.url.hostname, `${warn}${head}\n\n${cut.trim() || t('web.empty')}`);
    },
  };
}

/** Why a page could not be read, in the person's words. */
function fetchError(err: unknown, t: T): string {
  if (!(err instanceof HttpError)) return t('web.unreachable');
  switch (err.key) {
    case 'error.skillLinkPrivate':
      return t('web.private');
    case 'error.skillLinkTooLarge':
      return t('web.tooLarge');
    case 'error.skillLinkStatus':
      return t('web.status', { status: String(err.params?.status ?? '') });
    case 'error.skillLinkHttps':
      return t('web.badUrl');
    default:
      return t('web.unreachable');
  }
}

interface SearxResult {
  url?: unknown;
  title?: unknown;
  content?: unknown;
  publishedDate?: unknown;
}

function webSearch(t: T, base: string, o: WebToolOptions): FileTool {
  const get = o.searchFetch ?? fetch;
  return {
    name: 'web_search',
    permissionName: 'WebSearch',
    description: t('web.search'),
    input: {
      query: z.string().min(1).max(400).describe(t('web.searchQuery')),
      count: z.number().int().min(1).max(SEARCH_MAX).optional().describe(t('web.searchCount')),
    },
    target: (a) => String(a.query ?? '').trim(),
    cardInput: (a) => ({ query: String(a.query ?? '').trim() }),
    async run(a): Promise<ToolResult> {
      const query = String(a.query).trim();
      const count = (a.count as number | undefined) ?? SEARCH_DEFAULT;
      // The service is the one the server's own environment names, often on its private network:
      // its address is trusted as configured. What it returns is outside text.
      const url = new URL('search', base.endsWith('/') ? base : `${base}/`);
      url.searchParams.set('q', query);
      url.searchParams.set('format', 'json');
      url.searchParams.set('safesearch', '1');
      let res: Response;
      try {
        res = await get(url, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
          redirect: 'error',
        });
      } catch {
        throw new PathError(t('web.searchUnreachable'));
      }
      // SearXNG answers 403 when its settings leave JSON out of `search.formats`.
      if (res.status === 403) throw new PathError(t('web.searchNoJson'));
      if (!res.ok) throw new PathError(t('web.searchStatus', { status: String(res.status) }));
      let body: { results?: SearxResult[]; answers?: unknown[] };
      try {
        body = (await res.json()) as typeof body;
      } catch {
        throw new PathError(t('web.searchNoJson'));
      }
      const seen = new Set<string>();
      const lines: string[] = [];
      for (const answer of body.answers ?? []) {
        const text = typeof answer === 'string' ? answer : (answer as { answer?: unknown })?.answer;
        if (typeof text === 'string' && text.trim()) lines.push(`${t('web.answer')}: ${oneLine(text)}`);
      }
      for (const r of body.results ?? []) {
        if (lines.length >= count + (body.answers?.length ?? 0)) break;
        if (typeof r.url !== 'string' || !/^https?:\/\//i.test(r.url) || seen.has(r.url)) continue;
        seen.add(r.url);
        const n = seen.size;
        const title = typeof r.title === 'string' && r.title.trim() ? oneLine(r.title) : r.url;
        const date =
          typeof r.publishedDate === 'string' && r.publishedDate ? ` (${r.publishedDate.slice(0, 10)})` : '';
        const snippet = typeof r.content === 'string' ? oneLine(r.content).slice(0, SNIPPET_MAX) : '';
        lines.push(
          [`${n}. ${title}${date}`, `   ${r.url}`, ...(snippet ? [`   ${snippet}`] : [])].join('\n'),
        );
      }
      if (!seen.size && !lines.length) return t('web.noResults', { query });
      return o.mark(t('web.searchSource'), lines.join('\n'));
    },
  };
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  middot: '·',
  bull: '•',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
};

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n =
        code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return NAMED[code.toLowerCase()] ?? whole;
  });
}

/** Tags whose contents are never text a reader reads: skipped whole, up to their closing tag. */
const SKIPPED = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'form',
  'select',
  'head',
]);
/** Menus and footers, left out when the page marks its main part. */
const AROUND = new Set(['nav', 'header', 'footer', 'aside']);
/** Tags that start a new line. */
const BLOCKS = new Set([
  ...['p', 'div', 'section', 'article', 'main', 'ul', 'ol', 'table', 'tr', 'blockquote', 'pre'],
  ...['dl', 'dt', 'dd', 'figure', 'figcaption'],
]);

/** The text outside tags, in one pass. */
function textOf(html: string): string {
  let out = '';
  let tag = false;
  for (const c of html) {
    if (c === '<') tag = true;
    else if (c === '>') tag = false;
    else if (!tag) out += c;
  }
  return out;
}

/** The same text with A-Z lowered and nothing else changed, so its indexes match the original. */
const asciiLower = (s: string) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());

/** What is between an opening tag `name` and the last closing one, or null. Linear: two searches. */
function inside(html: string, lower: string, name: string, last = true): string | null {
  const open = lower.indexOf(`<${name}`);
  if (open < 0) return null;
  const start = lower.indexOf('>', open);
  const end = last ? lower.lastIndexOf(`</${name}`) : lower.indexOf(`</${name}`, start);
  return start < 0 || end <= start ? null : html.slice(start + 1, end);
}

/**
 * A page's text as a reader sees it: the main part when the page marks one, headings, paragraphs
 * and list items on their own lines, links with their addresses. No scripts, styles or forms. One
 * pass from start to end, so a page made to stall a pattern search costs no more than its length.
 */
export function readableText(html: string, base: URL): string {
  const lowerAll = asciiLower(html);
  // A title is a line; a page that makes it longer gets the start of it.
  const title = decode(textOf((inside(html, lowerAll, 'title', false) ?? '').slice(0, 1000)))
    .replace(/\s+/g, ' ')
    .trim();
  let doc = html;
  let main = false;
  for (const name of ['main', 'article']) {
    const part = inside(html, lowerAll, name);
    if (part !== null && textOf(part).trim().length > 200) {
      doc = part;
      main = true;
      break;
    }
  }
  if (!main) doc = inside(html, lowerAll, 'body') ?? html;
  const lower = asciiLower(doc);

  const out: string[] = [];
  /** Where an open link's text starts in `out`, and where it points. */
  let link: { at: number; href: string } | null = null;
  const closeLink = () => {
    if (!link) return;
    const text = out
      .slice(link.at + 1)
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    out[link.at] = text ? '[' : '';
    if (text) out.push(`](${link.href})`);
    link = null;
  };
  let at = 0;
  while (at < doc.length) {
    const lt = doc.indexOf('<', at);
    if (lt < 0) {
      out.push(doc.slice(at));
      break;
    }
    out.push(doc.slice(at, lt));
    if (lower.startsWith('<!--', lt)) {
      const end = doc.indexOf('-->', lt + 4);
      if (end < 0) break;
      at = end + 3;
      continue;
    }
    const gt = doc.indexOf('>', lt + 1);
    if (gt < 0) break;
    const tag = lower.slice(lt + 1, gt);
    at = gt + 1;
    const closing = tag.startsWith('/');
    const name = /^\/?([a-z][a-z0-9]*)/.exec(tag)?.[1];
    if (!name) {
      out.push(doc.slice(lt, gt + 1));
      continue;
    }
    if (!closing && (SKIPPED.has(name) || (main && AROUND.has(name)))) {
      // Its contents are skipped up to its own closing tag; with none, nothing after it is read.
      const end = lower.indexOf(`</${name}`, at);
      if (end < 0) break;
      const after = lower.indexOf('>', end);
      at = after < 0 ? doc.length : after + 1;
      continue;
    }
    const heading = /^h([1-6])$/.exec(name);
    if (heading) out.push(closing ? '\n\n' : `\n\n${'#'.repeat(Number(heading[1]))} `);
    else if (name === 'li' && !closing) out.push('\n- ');
    else if (name === 'br') out.push('\n');
    else if (BLOCKS.has(name)) out.push('\n');
    else if ((name === 'td' || name === 'th') && closing) out.push(' | ');
    else if (name === 'a') {
      closeLink();
      if (closing) continue;
      const raw = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/.exec(doc.slice(lt, gt + 1));
      const href = raw?.[1] ?? raw?.[2] ?? raw?.[3];
      if (!href) continue;
      try {
        const abs = new URL(decode(href), base).href;
        if (!/^https?:/i.test(abs)) continue;
        link = { at: out.length, href: abs };
        out.push('');
      } catch {
        // An address that does not parse leaves the text without a link.
      }
    } else out.push(' ');
  }
  closeLink();
  const lines = decode(out.join(''))
    .split('\n')
    .map((l) => l.replace(/[ \t\f\v\u00a0]+/g, ' ').trim())
    .filter((l, i, all) => l || (i > 0 && all[i - 1]));
  const text = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return title && !text.startsWith(`# ${title}`) ? `# ${title}\n\n${text}` : text;
}

/**
 * A page's bytes as text, in the character set its header or its own meta tag names (a Turkish
 * page may still be windows-1254 or ISO-8859-9); UTF-8 when it names none or one not known here.
 */
export function pageChars(body: Buffer, contentType: string): string {
  const named =
    /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1] ??
    /<meta[^>]{0,200}?charset\s*=\s*["']?([\w.:-]+)/i.exec(body.subarray(0, 4096).toString('latin1'))?.[1];
  try {
    return new TextDecoder(named ?? 'utf-8').decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}
