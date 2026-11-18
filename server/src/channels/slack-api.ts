import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { ReadableStream as WebStream } from 'node:stream/web';
import { MAX_RATE_WAIT_MS, pause, SEND_TRIES } from './common';

/** Refusals that say the bot token no longer works: revoked, the app uninstalled, the account gone. */
export const SLACK_AUTH_ERRORS = new Set([
  'invalid_auth',
  'token_revoked',
  'account_inactive',
  'not_authed',
  'token_expired',
]);

/** A refusal from Slack's Web API, with Slack's own error code and, when it limits us, the wait. */
export class SlackError extends Error {
  constructor(
    readonly code: string,
    readonly retryAfter?: number,
  ) {
    super(`Slack: ${code}`);
  }
}

/** A message as Slack's events and history give it. */
export interface SlackMessage {
  type?: string;
  subtype?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  app_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  files?: SlackFile[];
}

export interface SlackFile {
  id: string;
  name?: string;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
}

/** A Slack token of the kind it says it is: an app-level one (`xapp-`) or a bot's (`xoxb-`). */
export const slackToken = (raw: string, kind: 'app' | 'bot'): string | null => {
  const token = raw.trim();
  const prefix = kind === 'app' ? 'xapp-' : 'xoxb-';
  return token.startsWith(prefix) && /^[\w-]{20,300}$/.test(token) ? token : null;
};

/**
 * Whether Slack's files may be fetched from this address with the bot's token: only Slack's own
 * hosts (and the stand-in a test runs), so a link in a message cannot carry the token elsewhere.
 */
export function slackFileHost(url: string, base: string): boolean {
  try {
    const u = new URL(url);
    const own = new URL(base);
    if (u.host === own.host && u.protocol === own.protocol) return true;
    return u.protocol === 'https:' && (u.hostname === 'slack.com' || u.hostname.endsWith('.slack.com'));
  } catch {
    return false;
  }
}

/** Slack's Web API with one token; `base` is the API's address. */
export class SlackApi {
  constructor(
    private token: string,
    private base: string,
    /** Told after every call: null when Slack accepted the token, or the code when it refused it. */
    private watch?: (authError: string | null) => void,
    /** Aborts when the chat app stops, so a wait for Slack's "slow down" does not hold it up. */
    private stopping?: AbortSignal,
  ) {}

  /**
   * One method call. Arguments go form-encoded, which every method takes (some read ones take no
   * JSON); objects in them (blocks, file lists) go as JSON text. When Slack asks to slow down (429)
   * a short wait is served and the call is made again, so the rest of a long reply is not lost.
   */
  async call<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
    options: { retry?: boolean; headers?: (h: Headers) => void } = {},
  ): Promise<T> {
    const tries = options.retry === false ? 1 : SEND_TRIES;
    for (let n = 1; ; n++) {
      try {
        const body = await this.once<T>(method, params, signal, options.headers);
        this.watch?.(null);
        return body;
      } catch (err) {
        if (!(err instanceof SlackError)) throw err;
        if (SLACK_AUTH_ERRORS.has(err.code)) this.watch?.(err.code);
        if (err.code !== 'ratelimited' || n >= tries) throw err;
        const wait = (err.retryAfter ?? 1) * 1000;
        // A long ban is not waited out here; the send fails and the person is told.
        if (wait > MAX_RATE_WAIT_MS) throw err;
        await pause(wait, signal ?? this.stopping);
      }
    }
  }

  private async once<T>(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    headers?: (h: Headers) => void,
  ): Promise<T> {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      form.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    const res = await fetch(`${this.base}/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
      },
      body: form.toString(),
      signal,
    });
    headers?.(res.headers);
    if (res.status === 429) {
      throw new SlackError('ratelimited', Number(res.headers.get('retry-after')) || 30);
    }
    let body: { ok?: boolean; error?: string } & Record<string, unknown>;
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new SlackError(`http_${res.status}`);
    }
    if (!body.ok) throw new SlackError(body.error ?? `http_${res.status}`);
    return body as T;
  }

  /** The address to open the Socket Mode connection at; needs the app-level token. */
  async socketUrl(signal?: AbortSignal): Promise<string> {
    // The socket backs off by itself, so a "slow down" is not waited out here.
    const r = await this.call<{ url: string }>('apps.connections.open', {}, signal, { retry: false });
    return r.url;
  }

  /** The workspace and the bot user the bot token stands for. */
  async authTest() {
    let scopes: string[] | null = null;
    const r = await this.call<{
      team_id: string;
      team: string;
      user_id: string;
      bot_id?: string;
      url?: string;
    }>('auth.test', {}, undefined, {
      // Slack lists the token's permissions in a header; null when it does not say.
      headers: (h) => {
        const raw = h.get('x-oauth-scopes');
        scopes =
          raw === null
            ? null
            : raw
                .split(',')
                .map((x) => x.trim())
                .filter(Boolean);
      },
    });
    return { ...r, scopes: scopes as string[] | null };
  }

  /** Posts a message; the `ts` Slack gave it. */
  async post(channel: string, text: string, extra: Record<string, unknown> = {}): Promise<string> {
    const r = await this.call<{ ts: string }>('chat.postMessage', {
      channel,
      text,
      unfurl_links: false,
      unfurl_media: false,
      ...extra,
    });
    return r.ts;
  }

  /** A message only `user` sees, in a channel. */
  ephemeral(channel: string, user: string, text: string, threadTs?: string) {
    return this.call('chat.postEphemeral', { channel, user, text, thread_ts: threadTs });
  }

  /**
   * The last `keep` messages of a thread, oldest first. Slack pages a thread from its start, so a
   * long one is read page by page to its end; past `pages` pages the newest are not reached and
   * what was read is kept. Slack limits this method tightly, so a request reads a thread once.
   */
  async replies(
    channel: string,
    ts: string,
    keep: number,
    pages = 5,
    /** Only messages after this one; the thread's first message always comes. */
    oldest?: string,
  ): Promise<SlackMessage[]> {
    let all: SlackMessage[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < pages; page++) {
      let r;
      try {
        r = await this.call<{
          messages?: SlackMessage[];
          has_more?: boolean;
          response_metadata?: { next_cursor?: string };
        }>('conversations.replies', { channel, ts, limit: 200, cursor, oldest });
      } catch (err) {
        // A later page that fails leaves what was read; only a thread nothing of was read is an error.
        if (page === 0) throw err;
        break;
      }
      all = [...all, ...(r.messages ?? [])].slice(-keep);
      cursor = r.response_metadata?.next_cursor || undefined;
      if (!r.has_more || !cursor) break;
    }
    return all;
  }

  /** A Slack user's name as their workspace shows it. */
  async userName(user: string): Promise<string> {
    const r = await this.call<{
      user?: { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } };
    }>('users.info', { user });
    const u = r.user;
    return (u?.profile?.display_name || u?.profile?.real_name || u?.real_name || u?.name || user).slice(
      0,
      80,
    );
  }

  react(channel: string, ts: string, name: string) {
    return this.call('reactions.add', { channel, timestamp: ts, name }).catch(() => {});
  }

  unreact(channel: string, ts: string, name: string) {
    return this.call('reactions.remove', { channel, timestamp: ts, name }).catch(() => {});
  }

  /** A file of a message, fetched with the bot's token from Slack's own hosts only. */
  async download(url: string, signal?: AbortSignal): Promise<Readable> {
    if (!slackFileHost(url, this.base)) throw new SlackError('file_host');
    const res = await fetch(url, { headers: { authorization: `Bearer ${this.token}` }, signal });
    if (!res.ok || !res.body) throw new SlackError(`http_${res.status}`);
    return Readable.fromWeb(res.body as WebStream);
  }

  /** Sends a file from the server's disk into a channel (and thread), the way Slack asks for now. */
  async upload(channel: string, path: string, name: string, threadTs?: string): Promise<void> {
    const body = await readFile(path);
    const slot = await this.call<{ upload_url: string; file_id: string }>('files.getUploadURLExternal', {
      filename: name,
      length: String(body.length),
    });
    if (!slackFileHost(slot.upload_url, this.base)) throw new SlackError('file_host');
    const res = await fetch(slot.upload_url, { method: 'POST', body });
    if (!res.ok) throw new SlackError(`http_${res.status}`);
    await this.call('files.completeUploadExternal', {
      files: [{ id: slot.file_id, title: name }],
      channel_id: channel,
      thread_ts: threadTs,
    });
  }
}
