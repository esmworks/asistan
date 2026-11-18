import { randomBytes, timingSafeEqual } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MAX_UPLOAD_BYTES,
  questionItems,
  type Approval,
  telegramToken,
  type Message,
  type NoticeEvent,
  type TelegramStatus,
  type TurnEvent,
} from '@yumakbot/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import type { T } from '../i18n';
import type { Services } from '../services';
import type { VaultService } from '../services/vault';
import { saveUpload, stagingDir } from '../uploads';
import { HttpError, newId, truncate } from '../util';
import { qrImage } from './qr';
import {
  cardView,
  chatCommand,
  lastWroteVia,
  messageFiles,
  parseChoice,
  receivedName,
  SendQueue,
} from './common';
import { telegramMessages } from './format';
import {
  TelegramApi,
  TelegramError,
  type TgCallback,
  type TgFile,
  type TgMessage,
  type TgUpdate,
} from './telegram-api';

type Row = typeof schema.channels.$inferSelect;

/** Where a forwarded Telegram message came from, as the Bot API gives it (older fields too). */
type Forward = {
  forward_origin?: {
    type?: string;
    sender_user?: { first_name?: string; last_name?: string; username?: string };
    sender_user_name?: string;
    sender_chat?: { title?: string };
    chat?: { title?: string };
  };
  forward_date?: number;
  forward_from?: { first_name?: string; last_name?: string };
  forward_from_chat?: { title?: string };
  forward_sender_name?: string;
};

/**
 * Who a forwarded message came from, as a name; null when the message is the person's own. A
 * forward is someone else's words, whatever account sent it on.
 */
export function forwardedFrom(m: TgMessage): string | null {
  const f = m as TgMessage & Forward;
  if (!f.forward_origin && !f.forward_date && !f.forward_from && !f.forward_from_chat) return null;
  const o = f.forward_origin;
  const user = o?.sender_user ?? f.forward_from;
  const name =
    [user?.first_name, user?.last_name].filter(Boolean).join(' ') ||
    o?.sender_user_name ||
    o?.sender_chat?.title ||
    o?.chat?.title ||
    f.forward_from_chat?.title ||
    f.forward_sender_name ||
    '';
  return name.slice(0, 80);
}

/** A pairing link works this long. */
const PAIR_MS = 15 * 60_000;
/** Telegram's limits: files a bot may download, and files it may send. */
const DOWNLOAD_MAX = 20 * 1024 * 1024;
const SEND_MAX = 50 * 1024 * 1024;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

const sameText = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Each bot can have a Telegram bot of its own, made with BotFather. The server reads its messages
 * by asking Telegram for them (no public address needed), and only from the one Telegram account
 * that paired with it. What that account writes goes to the bot's main conversation as the
 * person's message; while the person last wrote from Telegram, the bot's replies, files and cards
 * go back there.
 */
export class TelegramChannels {
  private polls = new Map<string, { stop: AbortController; done: Promise<void> }>();
  private typing = new Map<string, NodeJS.Timeout>();
  private sends = new SendQueue();
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
    this.unsubs.push(this.ctx.bus.on('notice', (e) => void this.notice(e).catch(() => {})));
    // A bot that was deleted leaves its Telegram bot behind with no one to answer for.
    await this.ctx.db
      .delete(schema.channels)
      .where(and(eq(schema.channels.kind, 'telegram'), isNull(schema.channels.botId)));
    for (const row of await this.rows()) if (row.secret) this.listen(row.id);
  }

  async stop() {
    this.stopped = true;
    for (const u of this.unsubs) u();
    for (const p of this.polls.values()) p.stop.abort();
    await Promise.all([...this.polls.values()].map((p) => p.done));
    this.polls.clear();
    for (const timer of this.typing.values()) clearInterval(timer);
    this.typing.clear();
    await this.sends.drain();
  }

  // The app's side

  async status(botId: string): Promise<TelegramStatus> {
    await this.services.bots.get(botId);
    const row = await this.forBot(botId);
    const account = row?.account as { username?: string; name?: string } | undefined;
    const pairing = !!row?.pairCode && !!row.pairUntil && row.pairUntil.getTime() > Date.now();
    const pairLink =
      pairing && account?.username ? `https://t.me/${account.username}?start=${row.pairCode}` : null;
    return {
      connected: !!row?.secret,
      bot: account?.username ? { username: account.username, name: account.name ?? account.username } : null,
      owner: row?.owner ? { name: row.ownerName ?? '' } : null,
      pairLink,
      pairQr: pairLink ? await qrImage(pairLink) : null,
      pairUntil: pairing ? row.pairUntil!.toISOString() : null,
      notices: (row?.settings as { notices?: boolean } | undefined)?.notices !== false,
      error: row?.error ?? null,
    };
  }

  /**
   * Saves a bot's Telegram token after Telegram accepts it, and starts a pairing: the link it
   * gives opens the Telegram bot with a code, and whoever presses Start there pairs.
   */
  async connect(botId: string, raw: string): Promise<TelegramStatus> {
    const bot = await this.services.bots.get(botId);
    const token = telegramToken(raw);
    if (!token) throw new HttpError(400, 'error.telegramToken');
    const api = this.api(token);
    let me;
    try {
      me = await api.getMe();
    } catch (err) {
      if (err instanceof TelegramError && (err.code === 401 || err.code === 404)) {
        throw new HttpError(400, 'error.telegramTokenRefused');
      }
      throw new HttpError(502, 'error.telegramUnreachable');
    }
    if (!me.username) throw new HttpError(400, 'error.telegramToken');
    // One Telegram bot answers for one bot here, or the two would read each other's messages.
    for (const other of await this.rows()) {
      if (other.botId !== botId && (other.account as { id?: number }).id === me.id) {
        const name = await this.services.bots.get(other.botId!).then(
          (b) => b.name,
          () => '?',
        );
        throw new HttpError(409, 'error.telegramInUse', { bot: name });
      }
    }
    // Messages come by asking for them; a webhook left from elsewhere would keep them away.
    await api.call('deleteWebhook', { drop_pending_updates: false }).catch(() => {});
    const t = await this.services.settings.translator();
    await api
      .call('setMyCommands', {
        commands: [
          { command: 'stop', description: t('channel.cmdStop') },
          { command: 'new', description: t('channel.cmdNew') },
        ],
      })
      .catch(() => {});
    const existing = await this.forBot(botId);
    const sameBot = (existing?.account as { id?: number } | undefined)?.id === me.id;
    const values = {
      secret: this.vault.seal(token),
      account: { id: me.id, username: me.username, name: me.first_name },
      error: null,
      pairCode: randomBytes(16).toString('base64url'),
      pairUntil: new Date(Date.now() + PAIR_MS),
      // Another Telegram bot starts over: nobody has paired with it yet.
      ...(!sameBot && { owner: null, ownerName: null, cursor: null }),
    };
    let id: string;
    if (existing) {
      id = existing.id;
      await this.ctx.db.update(schema.channels).set(values).where(eq(schema.channels.id, id));
    } else {
      id = newId();
      await this.ctx.db.insert(schema.channels).values({ id, kind: 'telegram', botId: bot.id, ...values });
    }
    this.listen(id);
    this.changed();
    return this.status(botId);
  }

  /** A new pairing link, for another phone or after the last one ran out. */
  async pair(botId: string): Promise<TelegramStatus> {
    const row = await this.forBot(botId);
    if (!row?.secret) throw new HttpError(409, 'error.telegramNotConnected');
    await this.ctx.db
      .update(schema.channels)
      .set({ pairCode: randomBytes(16).toString('base64url'), pairUntil: new Date(Date.now() + PAIR_MS) })
      .where(eq(schema.channels.id, row.id));
    this.changed();
    return this.status(botId);
  }

  async update(botId: string, patch: { notices: boolean }): Promise<TelegramStatus> {
    const row = await this.forBot(botId);
    if (!row) throw new HttpError(409, 'error.telegramNotConnected');
    await this.ctx.db
      .update(schema.channels)
      .set({ settings: { ...row.settings, notices: patch.notices } })
      .where(eq(schema.channels.id, row.id));
    this.changed();
    return this.status(botId);
  }

  /** Forgets the token and the paired account; the Telegram bot itself stays with its owner. */
  async disconnect(botId: string): Promise<void> {
    const row = await this.forBot(botId);
    if (!row) return;
    this.halt(row.id);
    await this.ctx.db.delete(schema.channels).where(eq(schema.channels.id, row.id));
    this.changed();
  }

  // Reading Telegram

  private listen(id: string) {
    if (this.stopped) return;
    this.halt(id);
    const stop = new AbortController();
    const done = this.poll(id, stop.signal).catch((err: unknown) => console.warn('telegram', err));
    this.polls.set(id, { stop, done });
  }

  private halt(id: string) {
    this.polls.get(id)?.stop.abort();
    this.polls.delete(id);
  }

  private async poll(id: string, signal: AbortSignal) {
    let wait = 1000;
    while (!signal.aborted) {
      const row = await this.row(id);
      if (!row?.secret || !row.botId) return;
      const api = this.api(this.vault.open(row.secret));
      try {
        const updates = await api.getUpdates(
          row.cursor ? Number(row.cursor) : undefined,
          this.ctx.config.telegramPollSeconds,
          signal,
        );
        if (row.error) await this.setError(id, null);
        for (const u of updates) {
          if (signal.aborted) return;
          await this.handle(id, api, u).catch((err: unknown) => console.warn('telegram update', err));
          await this.ctx.db
            .update(schema.channels)
            .set({ cursor: String(u.update_id + 1) })
            .where(eq(schema.channels.id, id));
        }
        wait = 1000;
      } catch (err) {
        if (signal.aborted) return;
        if (err instanceof TelegramError) {
          await this.setError(id, err.description || err.message);
          // The token was revoked or the bot deleted: asking again changes nothing.
          if (err.code === 401 || err.code === 404) return;
          if (err.retryAfter) wait = Math.max(wait, err.retryAfter * 1000);
        } else {
          console.warn('telegram poll', (err as Error).message);
        }
        await sleep(wait, signal);
        wait = Math.min(wait * 2, 60_000);
      }
    }
  }

  private async handle(id: string, api: TelegramApi, u: TgUpdate) {
    const row = await this.row(id);
    if (!row?.botId) return;
    if (u.callback_query) return this.pressed(row, api, u.callback_query);
    const m = u.message;
    // Only one-to-one chats with a person; groups and other bots are not read.
    if (!m?.from || m.from.is_bot || m.chat.type !== 'private') return;
    const t = await this.services.settings.translator();
    const start = /^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/.exec(m.text?.trim() ?? '');
    if (start) return this.paired(row, api, m, start[1], t);
    // Nobody but the paired account is listened to, not even with a reply.
    if (!row.owner || String(m.from.id) !== row.owner) return;
    const bot = await this.services.bots.get(row.botId).catch(() => null);
    if (!bot || bot.archivedAt) {
      await api.sendMessage(m.chat.id, t('channel.botArchived'));
      return;
    }
    // The conversation of the person who set the chat up.
    const thread = await this.services.threads.main(bot.id, row.userId);
    const text = (m.text || m.caption || '').trim();
    // Someone else's words the person passed on: never a command, and the bot reads them as data.
    const forward = forwardedFrom(m);
    const done = forward === null ? await chatCommand(this.services, thread.id, text, t) : null;
    if (done) {
      await api.sendMessage(m.chat.id, done);
      return;
    }
    const files = await this.received(api, m, thread.id, t);
    if (!text && !files.length) return;
    const replyTo = m.reply_to_message
      ? await this.ours(row.id, String(m.reply_to_message.message_id))
      : null;
    // Known before the bot starts, so "typing…" and its reply find their way back here.
    await this.ctx.db
      .update(schema.channels)
      .set({ settings: { ...row.settings, threadId: thread.id } })
      .where(eq(schema.channels.id, row.id));
    const { message } = await this.services.inbox.send(thread.id, {
      text,
      files,
      clientId: `telegram:${m.chat.id}:${m.message_id}`,
      userId: row.userId,
      ...(replyTo && { replyTo }),
      props: {
        via: 'telegram',
        ...(forward !== null && { outside: 'forward', ...(forward && { forwardedFrom: forward }) }),
      },
    });
    await this.remember(row.id, String(m.message_id), message.id);
  }

  /** `/start <code>`: the account that sends the code shown in the app pairs with the bot. */
  private async paired(row: Row, api: TelegramApi, m: TgMessage, code: string | undefined, t: T) {
    const from = m.from!;
    const bot = await this.services.bots.get(row.botId!);
    if (row.owner && String(from.id) === row.owner && !code) {
      await api.sendMessage(m.chat.id, t('channel.alreadyPaired', { bot: bot.name }));
      return;
    }
    const valid =
      !!code &&
      !!row.pairCode &&
      !!row.pairUntil &&
      row.pairUntil.getTime() > Date.now() &&
      sameText(code, row.pairCode);
    if (!valid) {
      // Strangers who found the bot learn nothing; the person who already paired is told why.
      if (!row.owner || String(from.id) === row.owner) await api.sendMessage(m.chat.id, t('channel.badCode'));
      return;
    }
    const name =
      [from.first_name, from.last_name].filter(Boolean).join(' ') +
      (from.username ? ` (@${from.username})` : '');
    await this.ctx.db
      .update(schema.channels)
      .set({ owner: String(from.id), ownerName: name.trim(), pairCode: null, pairUntil: null })
      .where(eq(schema.channels.id, row.id));
    await api.sendMessage(m.chat.id, t('channel.paired', { bot: bot.name }));
    this.changed();
  }

  /** A button under a card: the person's answer to it, as if given in the app. */
  private async pressed(row: Row, api: TelegramApi, cb: TgCallback) {
    const t = await this.services.settings.translator();
    const answer = (text: string) =>
      api.call('answerCallbackQuery', { callback_query_id: cb.id, text }).catch(() => {});
    const choice = cb.data ? parseChoice(cb.data) : null;
    if (!row.owner || String(cb.from.id) !== row.owner || !choice) return answer('');
    const card = await this.services.approvals.get(choice.approvalId).catch(() => null);
    // A card of another bot cannot be answered from this one's chat.
    if (!card || card.botId !== row.botId) return answer(t('channel.cardClosed'));
    let result: string;
    try {
      if (choice.kind === 'a') {
        const allow = choice.value !== 'n';
        await this.services.approvals.answer(card.id, {
          decision: allow ? 'allow' : 'deny',
          remember: choice.value === 'r',
        });
        result = t(allow ? 'channel.allowed' : 'channel.denied');
      } else {
        const option = card.kind === 'question' ? this.option(card, Number(choice.value)) : null;
        if (option === null) return answer(t('channel.cardClosed'));
        await this.services.approvals.answer(card.id, { decision: 'allow', answer: option, remember: false });
        result = option;
      }
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) return answer(t('channel.cardClosed'));
      throw err;
    }
    await answer(truncate(result, 190));
    if (cb.message) {
      // The buttons go, and the card says how it was answered.
      await api
        .call('editMessageReplyMarkup', {
          chat_id: cb.message.chat.id,
          message_id: cb.message.message_id,
          reply_markup: { inline_keyboard: [] },
        })
        .catch(() => {});
      await api
        .sendMessage(cb.message.chat.id, `✓ ${result}`, {
          reply_parameters: { message_id: cb.message.message_id },
        })
        .catch(() => {});
    }
  }

  /** The choice a button stands for, on a one-question card. */
  private option(card: Approval, i: number): string | null {
    const { items } = questionItems(card);
    return items.length === 1 ? (items[0]!.options[i] ?? null) : null;
  }

  /** The files of a message, downloaded into the conversation's staging folder. */
  private async received(api: TelegramApi, m: TgMessage, threadId: string, t: T): Promise<string[]> {
    const found: [string, TgFile][] = [];
    if (m.photo?.length) found.push(['photo', m.photo.at(-1)!]);
    for (const kind of ['document', 'audio', 'voice', 'video', 'video_note', 'animation'] as const) {
      const f = m[kind];
      if (f) found.push([kind, f]);
    }
    const names: string[] = [];
    for (const [kind, f] of found) {
      const name = receivedName(kind, String(m.message_id), f.mime_type, f.file_name);
      if ((f.file_size ?? 0) > Math.min(DOWNLOAD_MAX, MAX_UPLOAD_BYTES)) {
        await api.sendMessage(m.chat.id, t('channel.fileTooLarge', { name }));
        continue;
      }
      try {
        const body = await api.download(f.file_id);
        const saved = await saveUpload(stagingDir(this.ctx.config.dataDir, threadId), name, body);
        names.push(saved.name);
      } catch (err) {
        console.warn('telegram file', (err as Error).message);
        await api.sendMessage(m.chat.id, t('channel.fileFailed', { name }));
      }
    }
    return names;
  }

  // Writing to Telegram

  /** A new message here that the paired person should see in Telegram. */
  private async outgoing(m: Message) {
    if (this.stopped || !['assistant', 'approval', 'error'].includes(m.role)) return;
    const thread = await this.services.threads.row(m.threadId).catch(() => null);
    if (!thread) return;
    const row = await this.forBot(thread.botId);
    if (!row?.secret || !row.owner) return;
    const settings = row.settings as { threadId?: string; notices?: boolean };
    const here = settings.threadId === m.threadId && (await lastWroteVia(this.ctx, m.threadId, 'telegram'));
    const t = await this.services.settings.translator();
    const api = this.api(this.vault.open(row.secret));
    const chat = row.owner;
    // A routine's report is written in the routine's conversation and copied to the main one; the
    // copy is the one sent, so it arrives once.
    const report = m.props.routineReport === true;
    const headed = () => `📋 **${String(m.props.routineName ?? '') || t('channel.routine')}**\n\n${m.text}`;
    // Turned off, routine reports stay in the app wherever the person talks from.
    if (report && settings.notices === false) return;
    if (!here) {
      // A routine's report from another conversation, when the person wants those here too.
      if (settings.notices === false || !report || m.role !== 'assistant' || !m.text.trim()) return;
      await this.sends.run(row.id, async () => {
        await this.text(api, chat, headed());
      });
      return;
    }
    await this.sends.run(row.id, async () => {
      if (m.role === 'approval') {
        const card = await this.services.approvals.get(String(m.props.approvalId)).catch(() => null);
        if (!card || card.status !== 'pending') return;
        const view = cardView(card, m.props, t);
        const sent = await this.text(
          api,
          chat,
          view.text,
          view.buttons.length ? this.keyboard(view.buttons) : undefined,
        );
        if (sent) await this.remember(row.id, sent, m.id);
        return;
      }
      if (m.role === 'error') {
        await this.text(api, chat, `⚠️ ${m.text}`);
        return;
      }
      if (m.author !== `bot:${thread.botId}`) return;
      if (m.text.trim()) {
        const sent = await this.text(api, chat, report ? headed() : m.text);
        if (sent) await this.remember(row.id, sent, m.id);
      }
      for (const f of messageFiles(m)) {
        const path = join(this.ctx.config.dataDir, 'workspaces', f.path);
        const size = await stat(path).then(
          (s) => s.size,
          () => -1,
        );
        if (size < 0 || size > SEND_MAX) {
          await this.text(api, chat, t('channel.fileInApp', { name: f.name }));
          continue;
        }
        try {
          const sent = await api.sendDocument(chat, path);
          await this.remember(row.id, String(sent.message_id), m.id);
        } catch (err) {
          console.warn('telegram send file', (err as Error).message);
          await this.text(api, chat, t('channel.fileInApp', { name: f.name }));
        }
      }
    });
  }

  /** Sends a reply in as many messages as it takes; the id of the last one sent. */
  private async text(api: TelegramApi, chat: string, md: string, markup?: unknown): Promise<string | null> {
    const parts = telegramMessages(md);
    let last: string | null = null;
    for (const [i, p] of parts.entries()) {
      const extra = i === parts.length - 1 && markup ? { reply_markup: markup } : {};
      let sent;
      try {
        sent = await api.sendMessage(chat, p.html, { parse_mode: 'HTML', ...extra });
      } catch (err) {
        // Telegram refused the marks: the words as written still arrive.
        if (!(err instanceof TelegramError) || err.code !== 400) throw err;
        sent = await api.sendMessage(chat, p.plain, extra);
      }
      last = String(sent.message_id);
    }
    return last;
  }

  private keyboard(buttons: { label: string; data: string }[]) {
    // Two short choices side by side; longer ones each on a line of their own.
    const rows: { text: string; callback_data: string }[][] = [];
    for (const b of buttons) {
      const button = { text: b.label, callback_data: b.data };
      const last = rows.at(-1);
      if (last && last.length < 3 && buttons.every((x) => x.label.length <= 16)) last.push(button);
      else rows.push([button]);
    }
    return { inline_keyboard: rows };
  }

  /** "typing…" in Telegram while the bot works on what the person wrote there. */
  private async turnState(e: TurnEvent) {
    const row = await this.forBot(e.botId);
    const active =
      !!row?.secret &&
      !!row.owner &&
      (row.settings as { threadId?: string }).threadId === e.threadId &&
      (e.state === 'running' || e.state === 'queued') &&
      (await lastWroteVia(this.ctx, e.threadId, 'telegram'));
    const timer = this.typing.get(e.threadId);
    if (!active) {
      if (timer) clearInterval(timer);
      this.typing.delete(e.threadId);
      return;
    }
    if (timer || this.stopped) return;
    const api = this.api(this.vault.open(row.secret!));
    const send = () =>
      void api.call('sendChatAction', { chat_id: row.owner, action: 'typing' }).catch(() => {});
    send();
    const next = setInterval(send, 4500);
    next.unref?.();
    this.typing.set(e.threadId, next);
  }

  /** A card or a failure in another conversation of the bot: a short note, so it is not missed. */
  private async notice(e: NoticeEvent) {
    if (this.stopped || e.kind === 'reply') return;
    const row = await this.forBot(e.botId);
    if (!row?.secret || !row.owner) return;
    const settings = row.settings as { threadId?: string; notices?: boolean };
    if (settings.notices === false) return;
    // The conversation the person writes to from Telegram gets its cards as cards, or the person
    // is in the app with it; either way a note would only repeat it.
    if (settings.threadId === e.threadId) return;
    const t = await this.services.settings.translator();
    const thread = await this.services.threads.row(e.threadId).catch(() => null);
    const title = thread?.title || t('channel.otherChat');
    const api = this.api(this.vault.open(row.secret));
    await this.sends.run(row.id, async () => {
      await this.text(
        api,
        row.owner!,
        t(e.kind === 'error' ? 'channel.noticeError' : 'channel.noticeNeedsYou', { title, text: e.text }),
      );
    });
  }

  // Records

  private api(token: string) {
    return new TelegramApi(token, this.ctx.config.telegramApi);
  }

  private async rows(): Promise<Row[]> {
    return this.ctx.db.select().from(schema.channels).where(eq(schema.channels.kind, 'telegram'));
  }

  private async row(id: string): Promise<Row | null> {
    const [row] = await this.ctx.db.select().from(schema.channels).where(eq(schema.channels.id, id)).limit(1);
    return row ?? null;
  }

  private async forBot(botId: string): Promise<Row | null> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.channels)
      .where(and(eq(schema.channels.kind, 'telegram'), eq(schema.channels.botId, botId)))
      .limit(1);
    return row ?? null;
  }

  private async setError(id: string, error: string | null) {
    await this.ctx.db.update(schema.channels).set({ error }).where(eq(schema.channels.id, id));
    this.changed();
  }

  private async remember(channelId: string, externalId: string, messageId: string) {
    await this.ctx.db
      .insert(schema.channelMessages)
      .values({ channelId, externalId, messageId })
      .onConflictDoNothing()
      .catch(() => {});
  }

  /** The message here that a Telegram message is, when it is one we know. */
  private async ours(channelId: string, externalId: string): Promise<string | null> {
    const [row] = await this.ctx.db
      .select({ messageId: schema.channelMessages.messageId })
      .from(schema.channelMessages)
      .where(
        and(
          eq(schema.channelMessages.channelId, channelId),
          eq(schema.channelMessages.externalId, externalId),
        ),
      )
      .limit(1);
    return row?.messageId ?? null;
  }

  private changed() {
    this.ctx.bus.refresh({ scope: 'channels' });
  }
}
