import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebStream } from 'node:stream/web';

/** A refusal from Discord's API: its status, Discord's own code and message, and the wait it asks for. */
export class DiscordError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfter?: number,
  ) {
    super(`Discord: ${status} ${code}`);
  }
}

/** A Discord user as messages and interactions carry them. */
export interface DiscordUser {
  id: string;
  username?: string;
  global_name?: string | null;
  bot?: boolean;
}

export interface DiscordAttachment {
  id: string;
  filename: string;
  size?: number;
  url: string;
  content_type?: string;
}

/** A message as the Gateway's `MESSAGE_CREATE` and the history call give it. */
export interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: DiscordUser;
  member?: { roles?: string[]; nick?: string | null };
  content?: string;
  mentions?: (DiscordUser & { member?: { nick?: string | null } })[];
  attachments?: DiscordAttachment[];
  message_reference?: { message_id?: string; channel_id?: string };
  referenced_message?: DiscordMessage | null;
  webhook_id?: string;
  timestamp?: string;
  /** 0 a plain message, 19 a reply; the others are joins, pins and other notices. */
  type?: number;
}

/** A button press as the Gateway's `INTERACTION_CREATE` gives it. */
export interface DiscordInteraction {
  id: string;
  token: string;
  /** 3: a press of a message's button. */
  type: number;
  guild_id?: string;
  channel_id?: string;
  member?: { user?: DiscordUser; roles?: string[]; nick?: string | null };
  user?: DiscordUser;
  message?: { id: string; content?: string };
  data?: { custom_id?: string };
}

/** A row of buttons under a post; Discord takes five a row. */
export interface DiscordButton {
  label: string;
  customId: string;
  /** 1 primary, 2 secondary, 3 success, 4 danger. */
  style: 1 | 2 | 3 | 4;
}

export interface PostOptions {
  /** The message the post replies to; a missing one does not stop the post. */
  replyTo?: string;
  buttons?: DiscordButton[];
  /** A file from disk sent with the post. */
  file?: { path: string; name?: string };
}

/**
 * Who a post may notify: the people it names, never a role, `@everyone` or `@here`, and not the
 * author of the message it replies to (the reply itself says it is for them).
 */
const MENTIONS = { parse: ['users'], replied_user: false };

/** Discord's own wording for an API caller; it asks every bot to send one. */
const USER_AGENT = 'DiscordBot (https://discord.com, 1)';

/** Most waits for a rate limit before the call is given up. */
const RETRIES = 3;

export const componentRows = (buttons: DiscordButton[]) => {
  const rows: { type: 1; components: Record<string, unknown>[] }[] = [];
  for (const [i, b] of buttons.slice(0, 25).entries()) {
    if (i % 5 === 0) rows.push({ type: 1, components: [] });
    rows
      .at(-1)!
      .components.push({ type: 2, style: b.style, label: b.label.slice(0, 80), custom_id: b.customId });
  }
  return rows;
};

/**
 * Whether a file may be fetched from this address: only Discord's own file hosts (and the
 * stand-in a test runs), so a link in a message cannot make the server fetch an address of its
 * choosing.
 */
export function discordFileHost(url: string, base: string): boolean {
  try {
    const u = new URL(url);
    const own = new URL(base);
    if (u.host === own.host && u.protocol === own.protocol) return true;
    return (
      u.protocol === 'https:' &&
      ['cdn.discordapp.com', 'media.discordapp.net'].includes(u.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

/** Discord's REST API with the bot's token; `base` is the API's address with its version. */
export class DiscordApi {
  constructor(
    private token: string,
    private base: string,
  ) {}

  /** One call; JSON in and out, or a form with a file. Waits out a rate limit a few times. */
  async call<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
    opts: { signal?: AbortSignal; form?: FormData; auth?: boolean } = {},
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { 'user-agent': USER_AGENT };
      if (opts.auth !== false) headers.authorization = `Bot ${this.token}`;
      if (body !== undefined && !opts.form) headers['content-type'] = 'application/json';
      const res = await fetch(`${this.base}${path}`, {
        method,
        headers,
        body: opts.form ?? (body === undefined ? undefined : JSON.stringify(body)),
        signal: opts.signal ?? AbortSignal.timeout(30_000),
      });
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      let data: Record<string, unknown> = {};
      try {
        data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        // Not JSON: a proxy's page; the status says enough.
      }
      if (res.ok) return data as T;
      if (res.status === 429) {
        const wait = Number(data.retry_after ?? res.headers.get('retry-after') ?? 1);
        if (attempt < RETRIES && wait <= 30) {
          await new Promise((r) => setTimeout(r, Math.max(wait, 0.1) * 1000));
          continue;
        }
        throw new DiscordError(429, 'rate_limited', wait);
      }
      const code = typeof data.code === 'number' && data.code ? String(data.code) : `http_${res.status}`;
      const message = typeof data.message === 'string' ? data.message : '';
      throw new DiscordError(res.status, message ? `${code} ${message}`.slice(0, 200) : code);
    }
  }

  me(signal?: AbortSignal) {
    return this.call<DiscordUser>('GET', '/users/@me', undefined, { signal });
  }

  /** The application the token belongs to: its id makes the link that adds the bot to a server. */
  application(signal?: AbortSignal) {
    return this.call<{ id: string; flags?: number }>('GET', '/oauth2/applications/@me', undefined, {
      signal,
    });
  }

  /** The address the Gateway connection opens at. */
  async gatewayUrl(signal?: AbortSignal): Promise<string> {
    const r = await this.call<{ url?: string }>('GET', '/gateway/bot', undefined, { signal });
    if (!r.url) throw new DiscordError(500, 'no_gateway');
    return r.url;
  }

  guilds() {
    return this.call<{ id: string; name: string }[]>('GET', '/users/@me/guilds');
  }

  roles(guildId: string) {
    return this.call<{ id: string; name: string; position?: number; managed?: boolean }[]>(
      'GET',
      `/guilds/${encodeURIComponent(guildId)}/roles`,
    );
  }

  /** A post, as a reply when `replyTo` is given; its id. */
  async post(channel: string, content: string, opts: PostOptions = {}): Promise<string> {
    const payload: Record<string, unknown> = {
      content,
      allowed_mentions: MENTIONS,
      ...(opts.replyTo && { message_reference: { message_id: opts.replyTo, fail_if_not_exists: false } }),
      ...(opts.buttons?.length && { components: componentRows(opts.buttons) }),
    };
    const path = `/channels/${encodeURIComponent(channel)}/messages`;
    if (opts.file) {
      const name = opts.file.name ?? basename(opts.file.path);
      const form = new FormData();
      form.set('payload_json', JSON.stringify({ ...payload, attachments: [{ id: 0, filename: name }] }));
      form.set('files[0]', new Blob([await readFile(opts.file.path)]), name);
      const r = await this.call<{ id: string }>('POST', path, undefined, { form });
      return r.id;
    }
    const r = await this.call<{ id: string }>('POST', path, payload);
    return r.id;
  }

  /** Changes a post's text; its buttons go unless new ones are given. */
  async edit(channel: string, id: string, content: string, buttons: DiscordButton[] = []) {
    await this.call('PATCH', `/channels/${encodeURIComponent(channel)}/messages/${encodeURIComponent(id)}`, {
      content,
      allowed_mentions: MENTIONS,
      components: componentRows(buttons),
    });
  }

  async remove(channel: string, id: string) {
    await this.call('DELETE', `/channels/${encodeURIComponent(channel)}/messages/${encodeURIComponent(id)}`);
  }

  async react(channel: string, id: string, emoji: string) {
    await this.call(
      'PUT',
      `/channels/${encodeURIComponent(channel)}/messages/${encodeURIComponent(id)}/reactions/${encodeURIComponent(emoji)}/@me`,
    ).catch(() => {});
  }

  async unreact(channel: string, id: string, emoji: string) {
    await this.call(
      'DELETE',
      `/channels/${encodeURIComponent(channel)}/messages/${encodeURIComponent(id)}/reactions/${encodeURIComponent(emoji)}/@me`,
    ).catch(() => {});
  }

  /** The channel's messages before `before`, newest first, as Discord gives them. */
  history(channel: string, before: string, limit: number) {
    const q = new URLSearchParams({ before, limit: String(limit) });
    return this.call<DiscordMessage[]>('GET', `/channels/${encodeURIComponent(channel)}/messages?${q}`);
  }

  /**
   * The answer to a button press, within the three seconds Discord waits: `note` a line only the
   * presser sees, `update` the pressed post's new text with its buttons gone, `ack` nothing seen.
   */
  async respond(
    interaction: { id: string; token: string },
    answer: { note: string } | { update: string } | { ack: true },
  ) {
    const body =
      'note' in answer
        ? { type: 4, data: { content: answer.note, flags: 64, allowed_mentions: { parse: [] } } }
        : 'update' in answer
          ? { type: 7, data: { content: answer.update, components: [], allowed_mentions: MENTIONS } }
          : { type: 6 };
    await this.call(
      'POST',
      `/interactions/${encodeURIComponent(interaction.id)}/${encodeURIComponent(interaction.token)}/callback`,
      body,
      { auth: false },
    );
  }

  /** A file a message carries, from Discord's file hosts only, as it arrives. */
  async download(url: string): Promise<Readable> {
    if (!discordFileHost(url, this.base)) throw new DiscordError(400, 'foreign_file_host');
    const res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(120_000),
      redirect: 'error',
    });
    if (!res.ok || !res.body) throw new DiscordError(res.status, `http_${res.status}`);
    return Readable.fromWeb(res.body as WebStream);
  }
}
