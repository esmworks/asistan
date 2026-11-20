import { hasSecretShape, type LinkPreview } from '@leafbot/shared';
import { scrubCanary } from './canary';
import { fetchPublic } from './skill-link';

/** Enough of a page to hold its head, where the title and description are. */
const PAGE_START = 256 * 1024;
const API_MAX = 512 * 1024;
const TIMEOUT_MS = 8_000;
/** A preview is kept this long, and a link that gave none is not asked again sooner. */
const KEEP_MS = 10 * 60_000;
const KEEP_MAX = 500;
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 300;
const USER_AGENT = 'LeafBot-LinkPreview';

/** A pull request or issue on GitHub: owner, repository, which of the two, and its number. */
const GITHUB = /^\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)(?:[/?#]|$)/;

type Fetch = typeof fetchPublic;

/** A path longer than this, or a part of it shaped like a code, is not something to read. */
const PATH_MAX = 300;
const CODE_PART = /^[A-Za-z0-9+/=_]{32,}$/;

/**
 * Whether a link may be read for a preview. A link in a bot's reply was written by the bot, and
 * reading it on a hover would send whatever it carries to its site without a click; so one that
 * holds something shaped like a key, a bot's private token or a long code is not read.
 */
export function previewable(url: URL): boolean {
  let text = url.href;
  try {
    text = decodeURIComponent(text);
  } catch {
    // Read as written.
  }
  if (hasSecretShape(text) || scrubCanary(text) !== text) return false;
  if (url.pathname.length > PATH_MAX) return false;
  return !url.pathname.split('/').some((part) => CODE_PART.test(part) && /\d/.test(part));
}

/**
 * What a web link in a conversation shows on a hover: the page's title, description and site
 * for any page, and for a GitHub pull request or issue its state and author. The server reads
 * the page when the link is first held under the pointer, so the site sees the server's address
 * (on the desktop app, the person's own connection) and that moment; the page's query string is
 * left out of that read, and no picture from the page is loaded in the app. Private addresses
 * are refused like every other read.
 */
export class LinkPreviews {
  private kept = new Map<string, { at: number; preview: LinkPreview | null }>();
  private asking = new Map<string, Promise<LinkPreview | null>>();

  constructor(
    private fetch: Fetch = fetchPublic,
    private clock: () => number = Date.now,
  ) {}

  async get(raw: string): Promise<LinkPreview | null> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    // Asked over https only: the read is the server's, and it does not go out in the clear.
    url.protocol = 'https:';
    url.hash = '';
    if (!previewable(url)) return null;
    // Only GitHub's own addresses keep theirs; for any other page, what is in the query (a search,
    // a session, something the bot put there) is not sent on.
    if (url.hostname !== 'github.com') url.search = '';
    const key = url.href;
    const hit = this.kept.get(key);
    if (hit && this.clock() - hit.at < KEEP_MS) return hit.preview;
    const running = this.asking.get(key);
    if (running) return running;
    const work = this.read(url)
      .catch(() => null)
      .then((preview) => {
        this.keep(key, preview);
        return preview;
      })
      .finally(() => this.asking.delete(key));
    this.asking.set(key, work);
    return work;
  }

  private keep(key: string, preview: LinkPreview | null) {
    this.kept.delete(key);
    this.kept.set(key, { at: this.clock(), preview });
    // The oldest go first once there are too many.
    while (this.kept.size > KEEP_MAX) this.kept.delete(this.kept.keys().next().value!);
  }

  private async read(url: URL): Promise<LinkPreview | null> {
    const gh = url.hostname === 'github.com' ? GITHUB.exec(url.pathname) : null;
    if (gh) return this.github(url, gh[1]!, gh[2]!, gh[3] === 'pull' ? 'pr' : 'issue', Number(gh[4]));
    const res = await this.fetch(url, PAGE_START, {
      start: true,
      redirects: 3,
      timeoutMs: TIMEOUT_MS,
      userAgent: USER_AGENT,
      accept: 'text/html,application/xhtml+xml',
    });
    if (!/html/i.test(res.contentType)) return null;
    return pagePreview(res.body.toString('utf8'), res.url);
  }

  private async github(url: URL, owner: string, repo: string, type: 'pr' | 'issue', number: number) {
    const api = new URL(
      `https://api.github.com/repos/${owner}/${repo}/${type === 'pr' ? 'pulls' : 'issues'}/${number}`,
    );
    const res = await this.fetch(api, API_MAX, {
      // A repository that was moved or renamed answers with a redirect to its new address.
      redirects: 2,
      timeoutMs: TIMEOUT_MS,
      userAgent: USER_AGENT,
      accept: 'application/vnd.github+json',
    });
    return githubPreview(JSON.parse(res.body.toString('utf8')) as GithubItem, url, `${owner}/${repo}`, type);
  }
}

interface GithubItem {
  number?: number;
  title?: string;
  state?: string;
  draft?: boolean;
  merged_at?: string | null;
  state_reason?: string | null;
  user?: { login?: string };
  pull_request?: unknown;
}

/** A pull request's or issue's state as the preview names it. */
export function githubPreview(
  item: GithubItem,
  url: URL,
  repo: string,
  type: 'pr' | 'issue',
): LinkPreview | null {
  if (typeof item.title !== 'string' || typeof item.number !== 'number') return null;
  // An issue number can belong to a pull request; it is shown as what it is.
  const kind = type === 'issue' && item.pull_request ? 'pr' : type;
  const state =
    kind === 'pr'
      ? item.merged_at
        ? 'merged'
        : item.state === 'closed'
          ? 'closed'
          : item.draft
            ? 'draft'
            : 'open'
      : item.state === 'closed'
        ? item.state_reason === 'not_planned'
          ? 'notPlanned'
          : 'closed'
        : 'open';
  return {
    url: url.href,
    site: 'GitHub',
    title: cut(item.title, TITLE_MAX),
    github: { kind, repo, number: item.number, state, author: item.user?.login ?? null },
  };
}

/** The title, description and site a page's head gives, from its social tags first. */
export function pagePreview(html: string, url: URL): LinkPreview | null {
  const end = html.search(/<\/head>/i);
  const head = end >= 0 ? html.slice(0, end) : html;
  const metas = new Map<string, string>();
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = attr(tag, 'property') ?? attr(tag, 'name');
    const content = attr(tag, 'content');
    if (name && content !== null && !metas.has(name.toLowerCase())) metas.set(name.toLowerCase(), content);
  }
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  const title = clean(metas.get('og:title') ?? metas.get('twitter:title') ?? titleTag ?? '');
  const description = clean(
    metas.get('og:description') ?? metas.get('twitter:description') ?? metas.get('description') ?? '',
  );
  if (!title && !description) return null;
  return {
    url: url.href,
    site: cut(clean(metas.get('og:site_name') ?? '') || url.hostname.replace(/^www\./, ''), 80),
    title: cut(title, TITLE_MAX) || null,
    description: cut(description, DESCRIPTION_MAX) || null,
  };
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function clean(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code: string) => {
      if (code[0] !== '#') return NAMED[code.toLowerCase()] ?? all;
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
