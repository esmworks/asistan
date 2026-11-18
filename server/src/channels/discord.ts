import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  discordInviteUrl,
  discordToken,
  MAX_UPLOAD_BYTES,
  questionItems,
  type Approval,
  type Bot,
  type DiscordServer,
  type DiscordStatus,
  type DiscordUpdate,
  type Message,
  type TurnEvent,
} from '@yumakbot/shared';
import { and, eq } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import type { T } from '../i18n';
import type { Services } from '../services';
import { atLeast } from '../services/access';
import type { VaultService } from '../services/vault';
import { saveUpload, stagingDir } from '../uploads';
import { OWNER_ID } from '../users';
import { HttpError, isStopRequest, newId, truncate } from '../util';
import { cardView, messageFiles, parseChoice, receivedName, SendQueue } from './common';
import {
  DiscordApi,
  DiscordError,
  type DiscordButton,
  type DiscordInteraction,
  type DiscordMessage,
  type DiscordUser,
} from './discord-api';
import { DiscordGateway, type GatewayEvent, type GatewayState } from './discord-gateway';
import { discordMessages } from './format';

type Row = typeof schema.channels.$inferSelect;

/** Earlier messages of a channel a new conversation reads: this many, from this long before it. */
const CONTEXT_MESSAGES = 10;
const CONTEXT_MS = 15 * 60_000;
const CONTEXT_CHARS = 8000;
/** Discord's limit on a bot's file, unless the server has a higher boost level. */
const SEND_MAX = 10 * 1024 * 1024;
/** How long a message is remembered, so the same one coming twice counts once. */
const SEEN_MS = 10 * 60_000;
/**
 * Most requests one person may have under way at once, and most over all. Anyone in a server may
 * write, and each request spends the model's budget.
 */
const PER_PERSON = 2;
const IN_ALL = 20;
/** Message kinds that are a person writing: a plain message and a reply. */
const WRITTEN = new Set([0, 19]);

interface Account {
  applicationId: string;
  botUserId: string;
  botName: string;
  messageContent: boolean;
}

interface Settings {
  /** For each Discord server, the roles whose members may use the bot; none: everyone there. */
  roles?: Record<string, string[]>;
}

/** A conversation the bot works on in Discord, until it is done. */
interface Work {
  channel: string;
  root: string;
  /** Who wrote the request under way: only they press its buttons or stop it. */
  requester: string;
  /** Their messages since the work started; each gets a mark of how it went. */
  messages: string[];
  /** The "Working on it…" post, until the first answer takes its place. */
  status: string | null;
  stopped: boolean;
}

/** Who wrote a Discord message, as people there see them. */
const nameOf = (u: DiscordUser, nick?: string | null) => nick || u.global_name || u.username || u.id;

/**
 * Discord's markup as plain words: the bot's own mention goes, other people's become their names,
 * roles and channels keep their ids, a custom emoji keeps its name.
 */
export function discordText(
  raw: string,
  botUserId: string,
  mentions: { id: string; name: string }[] = [],
): string {
  const names = new Map(mentions.map((m) => [m.id, m.name]));
  return raw
    .replace(new RegExp(`<@!?${botUserId}>`, 'g'), '')
    .replace(/<@!?(\d+)>/g, (_, id: string) => `@${names.get(id) ?? id}`)
    .replace(/<@&(\d+)>/g, (_, id: string) => `@role:${id}`)
    .replace(/<#(\d+)>/g, (_, id: string) => `#${id}`)
    .replace(/<a?:(\w+):\d+>/g, (_, name: string) => `:${name}:`)
    .trim();
}

/**
 * The server's Discord bot. It connects over Discord's Gateway, so no public address is needed.
 * Anyone in a server it was added to may mention it (or only members of the roles chosen for that
 * server); such a message starts a team conversation, and a reply to the bot's post goes on with it.
 * People there have no account here: their turns act for the server's owner, use only what the
 * team shares, may do no more with the bot than talk with it, and change nothing without a card.
 * Only the person who asked presses that card's buttons in Discord; in the app, as any card of a
 * team conversation.
 */
export class DiscordChannel {
  private gateway: DiscordGateway | null = null;
  private sends = new SendQueue();
  private seen = new Map<string, number>();
  private working = new Map<string, Work>();
  private unsubs: (() => void)[] = [];
  private stopped = false;

  constructor(
    private ctx: Ctx,
    private services: Services,
    private vault: VaultService,
  ) {}

  async start() {
    this.unsubs.push(this.services.threads.onMessage((m) => this.outgoing(m)));
    this.unsubs.push(this.ctx.bus.on('turn', (e) => void this.turnState(e).catch(() => {})));
    if ((await this.row())?.secret) await this.listen();
  }

  async stop() {
    this.stopped = true;
    for (const u of this.unsubs) u();
    this.gateway?.close();
    await this.gateway?.done;
    this.gateway = null;
    await this.sends.drain();
  }

  // The app's side

  async status(): Promise<DiscordStatus> {
    const row = await this.row();
    const account = row?.account as Partial<Account> | undefined;
    return {
      connected: !!row?.secret,
      botUser: account?.botName ?? null,
      botId: row?.botId ?? null,
      inviteUrl: account?.applicationId ? discordInviteUrl(account.applicationId) : null,
      servers: row?.secret ? await this.servers(row) : [],
      messageContent: account?.messageContent ?? true,
      error: row?.error ?? null,
    };
  }

  /** The servers the bot is in, with their roles; none when Discord does not answer now. */
  private async servers(row: Row): Promise<DiscordServer[]> {
    const api = this.api(row);
    const roles = (row.settings as Settings).roles ?? {};
    try {
      const guilds = await api.guilds();
      return await Promise.all(
        guilds.map(async (g) => {
          const all = await api.roles(g.id).catch(() => []);
          return {
            id: g.id,
            name: g.name,
            // `@everyone` has the server's id, and a role an app manages is that app's own.
            roles: all
              .filter((r) => r.id !== g.id && !r.managed)
              .sort((a, b) => (b.position ?? 0) - (a.position ?? 0))
              .map((r) => ({ id: r.id, name: r.name })),
            allowed: roles[g.id] ?? [],
          };
        }),
      );
    } catch (err) {
      console.warn('discord servers', (err as Error).message);
      return [];
    }
  }

  /** Saves the bot's token after Discord accepts it, and starts listening. */
  async connect(input: { token: string; botId: string | null }): Promise<DiscordStatus> {
    const token = discordToken(input.token);
    if (!token) throw new HttpError(400, 'error.discordToken');
    if (input.botId) await this.services.bots.get(input.botId);
    const api = new DiscordApi(token, this.ctx.config.discordApi);
    let me: DiscordUser;
    let applicationId: string;
    try {
      me = await api.me();
      // For apps made since 2020 the bot's user and its application share the id.
      applicationId = await api.application().then(
        (a) => a.id,
        () => me.id,
      );
    } catch (err) {
      if (err instanceof DiscordError && err.status < 500)
        throw new HttpError(400, 'error.discordRefused', { reason: err.code });
      throw new HttpError(502, 'error.discordUnreachable');
    }
    const existing = await this.row();
    const account: Account = {
      applicationId,
      botUserId: me.id,
      botName: nameOf(me),
      messageContent: true,
    };
    const values = {
      secret: this.vault.seal(token),
      account: { ...account },
      botId: input.botId,
      error: null,
      // Another bot's servers are not this one's.
      settings:
        existing && (existing.account as Partial<Account>).botUserId === me.id ? existing.settings : {},
    };
    if (existing) {
      await this.ctx.db.update(schema.channels).set(values).where(eq(schema.channels.id, existing.id));
    } else {
      await this.ctx.db
        .insert(schema.channels)
        .values({ id: newId(), kind: 'discord', userId: OWNER_ID, ...values });
    }
    await this.listen();
    this.changed();
    return this.status();
  }

  async update(patch: DiscordUpdate): Promise<DiscordStatus> {
    const row = await this.row();
    if (!row?.secret) throw new HttpError(409, 'error.discordNotConnected');
    const set: Partial<Row> = {};
    if (patch.botId !== undefined) {
      if (patch.botId) await this.services.bots.get(patch.botId);
      set.botId = patch.botId;
    }
    if (patch.roles) {
      const server = (await this.servers(row)).find((s) => s.id === patch.roles!.serverId);
      if (!server) throw new HttpError(400, 'error.discordServer');
      const known = new Set(server.roles.map((r) => r.id));
      const roles = { ...((row.settings as Settings).roles ?? {}) };
      const picked = [...new Set(patch.roles.roleIds)].filter((id) => known.has(id));
      if (picked.length) roles[server.id] = picked;
      else delete roles[server.id];
      set.settings = { ...row.settings, roles };
    }
    await this.ctx.db.update(schema.channels).set(set).where(eq(schema.channels.id, row.id));
    this.changed();
    return this.status();
  }

  /** Forgets the token; the bot stays in its servers until someone there removes it. */
  async disconnect(): Promise<void> {
    this.gateway?.close();
    this.gateway = null;
    this.working.clear();
    await this.ctx.db.delete(schema.channels).where(eq(schema.channels.kind, 'discord'));
    this.changed();
  }

  // Reading Discord

  private async listen() {
    this.gateway?.close();
    this.gateway = null;
    if (this.stopped) return;
    const row = await this.row();
    if (!row?.secret) return;
    const api = this.api(row);
    this.gateway = new DiscordGateway(
      this.vault.open(row.secret),
      (signal) => api.gatewayUrl(signal),
      (e) => this.event(e),
      (s) => void this.setState(s).catch(() => {}),
    );
  }

  private async event(e: GatewayEvent) {
    if (e.t === 'MESSAGE_CREATE') await this.received(e.d as unknown as DiscordMessage);
    else if (e.t === 'INTERACTION_CREATE') await this.pressed(e.d as unknown as DiscordInteraction);
  }

  /** Whether this message was handled already (a resumed connection may send it again). */
  private once(key: string): boolean {
    const now = Date.now();
    for (const [k, at] of this.seen) if (now - at > SEEN_MS) this.seen.delete(k);
    if (this.seen.has(key)) return false;
    this.seen.set(key, now);
    return true;
  }

  private async received(msg: DiscordMessage) {
    const row = await this.row();
    if (!row?.secret || !msg.channel_id || !msg.author) return;
    const account = row.account as unknown as Account;
    // Bots (this one too), webhooks and notices are not read, so two bots never answer each
    // other without end.
    if (msg.author.bot || msg.webhook_id || msg.author.id === account.botUserId) return;
    if (msg.type !== undefined && !WRITTEN.has(msg.type)) return;
    if (!this.once(`${msg.channel_id}:${msg.id}`)) return;
    const api = this.api(row);
    const t = await this.services.settings.translator();
    const mentioned =
      (msg.mentions ?? []).some((u) => u.id === account.botUserId) ||
      new RegExp(`<@!?${account.botUserId}>`).test(msg.content ?? '');
    if (!msg.guild_id) {
      // A direct message has no server, so no one chose who may use the bot there.
      await api.post(msg.channel_id, t('discord.dmOnly')).catch(() => {});
      return;
    }
    // Only a message that mentions the bot is for it; a reply keeps the mention by default.
    if (!mentioned) return;
    const allowed = this.rolesOf(row, msg.guild_id);
    // A mention from someone outside the chosen roles is not answered, nor told why.
    if (allowed.length && !(msg.member?.roles ?? []).some((r) => allowed.includes(r))) return;
    const author = nameOf(msg.author, msg.member?.nick);
    const text = discordText(msg.content ?? '', account.botUserId, this.mentioned(msg));
    const say = (key: Parameters<T>[0], vars?: Record<string, string>) =>
      api.post(msg.channel_id, t(key, vars), { replyTo: msg.id }).catch(() => {});

    // A reply to the bot's post goes on with that post's conversation: the bot replies to the
    // chain's first message with every post, so the post names it.
    const ref = msg.referenced_message;
    const toBot = !!ref && ref.author?.id === account.botUserId;
    const root = toBot && ref ? (ref.message_reference?.message_id ?? ref.id) : msg.id;
    const [bound] = toBot
      ? await this.ctx.db
          .select()
          .from(schema.discordThreads)
          .where(
            and(eq(schema.discordThreads.channel, msg.channel_id), eq(schema.discordThreads.rootId, root)),
          )
          .limit(1)
      : [];
    const work = bound ? this.working.get(bound.threadId) : undefined;

    // `stop` stops the request of whoever wrote it, not someone else's.
    if (bound && isStopRequest(text) && !msg.attachments?.length) {
      if (!work) return;
      if (work.requester !== msg.author.id) return say('discord.notYours');
      await this.halt(bound.threadId, work, api);
      return;
    }

    const mine = [...this.working.values()].filter((w) => w.requester === msg.author.id).length;
    if (!work || work.requester !== msg.author.id) {
      if (mine >= PER_PERSON) return say('discord.busyYou');
      if (this.working.size >= IN_ALL) return say('discord.busyAll');
    }

    let threadId: string;
    let bot: Bot | null;
    if (bound) {
      threadId = bound.threadId;
      const thread = await this.services.threads.row(threadId).catch(() => null);
      if (!thread) return;
      bot = await this.usable(row.userId, thread.botId);
      if (!bot) return say('discord.noBot');
    } else {
      bot = row.botId ? await this.usable(row.userId, row.botId) : null;
      if (!bot) return say('discord.noBot');
      // What a bot shared with nobody does is its owner's alone; a server is not that place.
      const access = bot.access ?? { everyone: 'none', people: {} };
      if (access.everyone === 'none' && !Object.keys(access.people).length) {
        return say('discord.botPrivate', { bot: bot.name });
      }
      const thread = await this.services.threads.create(bot.id, {
        kind: 'team',
        userId: null,
        title: truncate(text.replace(/\s+/g, ' '), 60) || bot.name,
      });
      threadId = thread.id;
      const inserted = await this.ctx.db
        .insert(schema.discordThreads)
        .values({ threadId, serverId: msg.guild_id, channel: msg.channel_id, rootId: root })
        .onConflictDoNothing()
        .returning();
      // Two replies at once to a post of the bot that had no conversation yet: the conversation
      // made first is the chain's, and this message goes there too.
      if (!inserted.length) {
        await this.services.threads.remove(threadId).catch(() => {});
        const [first] = await this.ctx.db
          .select({ threadId: schema.discordThreads.threadId })
          .from(schema.discordThreads)
          .where(
            and(eq(schema.discordThreads.channel, msg.channel_id), eq(schema.discordThreads.rootId, root)),
          )
          .limit(1);
        if (!first) return;
        threadId = first.threadId;
      }
    }

    const files = await this.files(api, msg, threadId, t);
    if (!text && !files.length) return;
    // A new conversation reads what came just before it in the channel, or the message it
    // replies to, as others' words.
    const history = bound ? '' : await this.context(api, msg, account, ref && !toBot ? ref : null);
    const busy = (await this.services.threads.state(threadId)) !== 'idle';
    // "Working on it…" goes up first, so even a quick answer takes its place.
    await this.started(threadId, msg, root, api, t);
    try {
      await this.services.inbox.send(threadId, {
        text,
        files,
        clientId: `discord:${msg.channel_id}:${msg.id}`,
        userId: row.userId,
        author,
        guest: true,
        // Words of someone else than who asked wait their turn: they answer no card of theirs.
        answers: !busy || work?.requester === msg.author.id,
        ...(history && { history }),
        props: { via: 'discord', discord: { author: msg.author.id, name: author } },
      });
    } catch (err) {
      await this.finished(threadId, api, '❌');
      throw err;
    }
  }

  /** The people a message mentions, by the names they have there. */
  private mentioned(msg: DiscordMessage) {
    return (msg.mentions ?? []).map((u) => ({ id: u.id, name: nameOf(u, u.member?.nick) }));
  }

  /**
   * What a new conversation reads first: the message it replies to, or else the channel's last
   * messages from shortly before it, `Name: text` each.
   */
  private async context(
    api: DiscordApi,
    msg: DiscordMessage,
    account: Account,
    quoted: DiscordMessage | null,
  ) {
    const line = (m: DiscordMessage) => {
      const words = discordText(m.content ?? '', account.botUserId, this.mentioned(m));
      const files = (m.attachments ?? []).map((a) => a.filename).join(', ');
      const said = [words, files && `(${files})`].filter(Boolean).join(' ');
      return said ? `${nameOf(m.author, m.member?.nick)}: ${said}` : '';
    };
    if (quoted) return truncate(line(quoted), CONTEXT_CHARS);
    // Without the text of every message, Discord gives the earlier ones empty.
    if (!account.messageContent) return '';
    const at = msg.timestamp ? Date.parse(msg.timestamp) : Date.now();
    const earlier = await api.history(msg.channel_id, msg.id, CONTEXT_MESSAGES).catch(() => []);
    const lines: string[] = [];
    for (const m of [...earlier].reverse()) {
      if (m.timestamp && at - Date.parse(m.timestamp) > CONTEXT_MS) continue;
      if (m.author?.id === account.botUserId) continue;
      const l = line(m);
      if (l) lines.push(l);
    }
    const kept: string[] = [];
    let size = 0;
    for (const l of lines.reverse()) {
      if (size + l.length > CONTEXT_CHARS) break;
      kept.unshift(l);
      size += l.length + 1;
    }
    return kept.join('\n');
  }

  /** The files of a message, downloaded into the conversation's staging folder. */
  private async files(api: DiscordApi, msg: DiscordMessage, threadId: string, t: T): Promise<string[]> {
    const names: string[] = [];
    for (const f of msg.attachments ?? []) {
      const name = receivedName('file', f.id, f.content_type, f.filename);
      if ((f.size ?? 0) > MAX_UPLOAD_BYTES) {
        await api
          .post(msg.channel_id, t('channel.fileTooLarge', { name }), { replyTo: msg.id })
          .catch(() => {});
        continue;
      }
      try {
        const body = await api.download(f.url);
        const saved = await saveUpload(stagingDir(this.ctx.config.dataDir, threadId), name, body);
        names.push(saved.name);
      } catch (err) {
        console.warn('discord file', (err as Error).message);
        await api
          .post(msg.channel_id, t('channel.fileFailed', { name }), { replyTo: msg.id })
          .catch(() => {});
      }
    }
    return names;
  }

  /** 👀 on the message, and a "Working on it…" post with Stop until the first answer. */
  private async started(threadId: string, msg: DiscordMessage, root: string, api: DiscordApi, t: T) {
    const work = this.working.get(threadId);
    await api.react(msg.channel_id, msg.id, '👀');
    if (work) {
      work.messages.push(msg.id);
      return;
    }
    const entry: Work = {
      channel: msg.channel_id,
      root,
      requester: msg.author.id,
      messages: [msg.id],
      status: null,
      stopped: false,
    };
    this.working.set(threadId, entry);
    await this.sends.run(this.key(entry), async () => {
      entry.status = await api
        .post(msg.channel_id, t('discord.working'), {
          replyTo: root,
          buttons: [{ label: t('discord.stop'), customId: `stop:${threadId}`, style: 2 }],
        })
        .catch(() => null);
    });
  }

  /** Stops the work on a conversation; its messages get ⏹ when it is done. */
  private async halt(threadId: string, work: Work, api: DiscordApi) {
    work.stopped = true;
    const stopped = await this.services.turns.interrupt(threadId);
    await this.services.jobs.stopFrom(threadId);
    if (!stopped) await this.finished(threadId, api, '⏹️');
  }

  /** A press of a button the bot posted: a card's answer, or Stop. */
  private async pressed(i: DiscordInteraction) {
    if (i.type !== 3 || !i.id || !i.token) return;
    const row = await this.row();
    if (!row?.secret) return;
    const api = this.api(row);
    const t = await this.services.settings.translator();
    const presser = i.member?.user ?? i.user;
    const data = i.data?.custom_id ?? '';
    const note = (key: Parameters<T>[0]) => api.respond(i, { note: t(key) }).catch(() => {});
    if (!presser) return;
    // A member who lost the chosen roles since asking presses nothing.
    const allowed = i.guild_id ? this.rolesOf(row, i.guild_id) : [];
    if (allowed.length && !(i.member?.roles ?? []).some((r) => allowed.includes(r)))
      return note('discord.notYours');

    const stop = /^stop:([\w-]+)$/.exec(data);
    if (stop) {
      const threadId = stop[1]!;
      const work = this.working.get(threadId);
      if (!work) return note('channel.cardClosed');
      if (work.requester !== presser.id) return note('discord.notYours');
      await api.respond(i, { ack: true }).catch(() => {});
      await this.halt(threadId, work, api);
      return;
    }

    const choice = parseChoice(data);
    if (!choice) return;
    const card = await this.services.approvals.get(choice.approvalId).catch(() => null);
    if (!card || card.status !== 'pending') return note('channel.cardClosed');
    const [bound] = await this.ctx.db
      .select()
      .from(schema.discordThreads)
      .where(eq(schema.discordThreads.threadId, card.threadId))
      .limit(1);
    if (!bound) return note('channel.cardClosed');
    if (card.kind === 'tool' && !this.rolesOf(row, bound.serverId).length) return note('discord.cardInApp');
    if ((await this.requesterOf(card)) !== presser.id) return note('discord.notYours');
    // "Always allow" is never offered here: a rule would count for everyone's requests.
    if (choice.kind === 'a' && choice.value === 'r') return note('discord.notYours');
    let option: string | null = null;
    if (choice.kind === 'q') {
      option = card.kind === 'question' ? this.option(card, Number(choice.value)) : null;
      if (option === null) return note('channel.cardClosed');
    }
    await api.respond(i, { ack: true }).catch(() => {});
    const allow = choice.kind === 'q' || choice.value !== 'n';
    try {
      await this.services.approvals.answer(
        card.id,
        option === null
          ? { decision: allow ? 'allow' : 'deny', remember: false }
          : { decision: 'allow', answer: option, remember: false },
        row.userId,
      );
    } catch (err) {
      if (err instanceof HttpError && (err.status === 409 || err.status === 403)) return;
      throw err;
    }
    // The buttons go, and the card says how it was answered and by whom.
    if (i.channel_id && i.message?.id) {
      const result = option ?? t(allow ? 'channel.allowed' : 'channel.denied');
      const name = nameOf(presser, i.member?.nick);
      const done = `${i.message.content ?? ''}\n\n${t('discord.answered', { result: truncate(result, 190), name })}`;
      await api.edit(i.channel_id, i.message.id, truncate(done, 2000)).catch(() => {});
    }
  }

  /** The Discord person whose request a card belongs to. */
  private async requesterOf(card: Approval): Promise<string | null> {
    const [row] = await this.ctx.db
      .select({ turnId: schema.approvals.turnId })
      .from(schema.approvals)
      .where(eq(schema.approvals.id, card.id))
      .limit(1);
    if (!row?.turnId) return null;
    const asked = await this.ctx.db
      .select({ props: schema.messages.props })
      .from(schema.messages)
      .where(and(eq(schema.messages.turnId, row.turnId), eq(schema.messages.role, 'user')));
    const ids = asked
      .map((m) => (m.props as { discord?: { author?: unknown } }).discord?.author)
      .filter((x): x is string => typeof x === 'string');
    // A turn that gathered several people's words is no one person's to answer from Discord.
    return new Set(ids).size === 1 ? ids[0]! : null;
  }

  /** The choice a button stands for, on a one-question card. */
  private option(card: Approval, i: number): string | null {
    const { items } = questionItems(card);
    return items.length === 1 ? (items[0]!.options[i] ?? null) : null;
  }

  // Writing to Discord

  private key(place: { channel: string; root: string }) {
    return `${place.channel}:${place.root}`;
  }

  /** A new message here that belongs in Discord too. */
  private async outgoing(m: Message) {
    if (this.stopped || !['assistant', 'approval', 'error', 'user'].includes(m.role)) return;
    // A person's line goes to Discord only when written in the app.
    if (m.role === 'user' && m.props.via === 'discord') return;
    const row = await this.row();
    if (!row?.secret) return;
    const [bound] = await this.ctx.db
      .select()
      .from(schema.discordThreads)
      .where(eq(schema.discordThreads.threadId, m.threadId))
      .limit(1);
    if (!bound) return;
    const thread = await this.services.threads.row(m.threadId).catch(() => null);
    if (!thread) return;
    const t = await this.services.settings.translator();
    const api = this.api(row);
    const place = { channel: bound.channel, root: bound.rootId };
    await this.sends.run(this.key(place), async () => {
      /** Posts in the conversation, the first in place of "Working on it…" when it still shows. */
      const write = async (parts: string[], last?: DiscordButton[]) => {
        const work = this.working.get(m.threadId);
        for (const [n, part] of parts.entries()) {
          const buttons = n === parts.length - 1 ? last : undefined;
          if (work?.status && n === 0) {
            const status = work.status;
            work.status = null;
            try {
              await api.edit(place.channel, status, part, buttons);
              continue;
            } catch {
              // Deleted meanwhile: a new post instead.
            }
          }
          await api.post(place.channel, part, { replyTo: place.root, buttons });
        }
      };
      if (m.role === 'user') {
        const [who] = await this.ctx.db
          .select({ displayName: schema.users.displayName, username: schema.users.username })
          .from(schema.messages)
          .innerJoin(schema.users, eq(schema.users.id, schema.messages.userId))
          .where(eq(schema.messages.id, m.id))
          .limit(1);
        if (!who) return;
        const [first = '', ...rest] = discordMessages(m.text);
        await api.post(place.channel, truncate(`**${who.displayName || who.username}**: ${first}`, 2000), {
          replyTo: place.root,
        });
        for (const part of rest) await api.post(place.channel, part, { replyTo: place.root });
        return;
      }
      if (m.role === 'approval') {
        const card = await this.services.approvals.get(String(m.props.approvalId)).catch(() => null);
        if (!card || card.status !== 'pending') return;
        const view = cardView(card, m.props, t);
        // A step's card is the only thing between a stranger's request and the team's things: in a
        // server where anyone may write, those who may change the bot answer it in the app.
        if (card.kind === 'tool' && !this.rolesOf(row, bound.serverId).length) {
          await write(discordMessages(`${view.text}\n\n_${t('discord.cardInApp')}_`));
          return;
        }
        const buttons: DiscordButton[] = view.buttons
          // A rule would count for everyone's requests, so it is never offered here.
          .filter((b) => !b.data.endsWith(':r'))
          .map((b) => ({
            label: b.label,
            customId: b.data,
            style: b.data.endsWith(':y') ? 3 : b.data.endsWith(':n') ? 4 : 2,
          }));
        await write(discordMessages(view.text), buttons);
        return;
      }
      if (m.role === 'error') {
        await write([truncate(`⚠️ ${m.text}`, 2000)]);
        await this.finished(thread.id, api, '❌');
        return;
      }
      if (m.author !== `bot:${thread.botId}`) return;
      await write(discordMessages(m.text));
      for (const f of messageFiles(m)) {
        const path = join(this.ctx.config.dataDir, 'workspaces', f.path);
        const size = await stat(path).then(
          (s) => s.size,
          () => -1,
        );
        if (size < 0 || size > SEND_MAX) {
          await api.post(place.channel, t('channel.fileInApp', { name: f.name }), { replyTo: place.root });
          continue;
        }
        try {
          await api.post(place.channel, '', { replyTo: place.root, file: { path, name: f.name } });
        } catch (err) {
          console.warn('discord send file', (err as Error).message);
          await api.post(place.channel, t('channel.fileInApp', { name: f.name }), { replyTo: place.root });
        }
      }
    });
  }

  /** The bot stopped working on a conversation: each message's 👀 becomes a mark of how it went. */
  private async turnState(e: TurnEvent) {
    if (e.state !== 'idle' || !this.working.has(e.threadId)) return;
    const row = await this.row();
    if (!row?.secret) return;
    const work = this.working.get(e.threadId)!;
    await this.finished(e.threadId, this.api(row), work.stopped ? '⏹️' : '✅');
  }

  private async finished(threadId: string, api: DiscordApi, mark: string) {
    const work = this.working.get(threadId);
    if (!work) return;
    this.working.delete(threadId);
    await this.sends.run(this.key(work), async () => {
      // No answer took its place (the bot stayed quiet, or was stopped): the post goes.
      if (work.status) await api.remove(work.channel, work.status).catch(() => {});
      for (const id of work.messages) {
        await api.unreact(work.channel, id, '👀');
        await api.react(work.channel, id, mark);
      }
    });
  }

  // Records

  private api(row: Row) {
    return new DiscordApi(this.vault.open(row.secret!), this.ctx.config.discordApi);
  }

  /** The roles whose members may use the bot in a server; none: everyone there. */
  private rolesOf(row: Row, serverId: string): string[] {
    return (row.settings as Settings).roles?.[serverId] ?? [];
  }

  private async row(): Promise<Row | null> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.channels)
      .where(eq(schema.channels.kind, 'discord'))
      .limit(1);
    return row ?? null;
  }

  /** The bot, when the person the turns act for may talk with it and it is not archived. */
  private async usable(userId: string, botId: string): Promise<Bot | null> {
    const bot = await this.services.bots.get(botId).catch(() => null);
    if (!bot || bot.archivedAt) return null;
    const level = await this.services.access.level(await this.services.access.viewerOf(userId), bot.id);
    return atLeast(level, 'chat') ? bot : null;
  }

  private async setState(s: GatewayState) {
    const row = await this.row();
    if (!row) return;
    const account = row.account as unknown as Account;
    const next = {
      ...account,
      messageContent: s.messageContent,
      ...(s.user && { botUserId: s.user.id, botName: s.user.name }),
    };
    if (row.error === s.error && JSON.stringify(next) === JSON.stringify(account)) return;
    await this.ctx.db
      .update(schema.channels)
      .set({ error: s.error, account: next })
      .where(eq(schema.channels.id, row.id));
    this.changed();
  }

  private changed() {
    this.ctx.bus.refresh({ scope: 'channels' });
  }
}
