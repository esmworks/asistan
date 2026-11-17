import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import {
  questionItems,
  type Bot,
  type Message,
  type NoticeEvent,
  type TurnEvent,
  type WhatsAppSet,
  type WhatsAppStatus,
} from '@yumakbot/shared';
import { eq, like } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import type { T } from '../i18n';
import type { Services } from '../services';
import type { VaultService } from '../services/vault';
import { saveUpload, stagingDir } from '../uploads';
import { HttpError, newId } from '../util';
import { cardView, chatCommand, lastWroteVia, messageFiles, mimeOf, receivedName, SendQueue } from './common';
import { whatsappMessages } from './format';
import { qrImage } from './qr';

type Row = typeof schema.channels.$inferSelect;
type Settings = { mode?: WhatsAppSet['mode']; phone?: string; notices?: boolean; threadId?: string };

/** How long a QR setup may wait to be scanned before it is given up on. */
const LINK_MS = 5 * 60_000;
/** WhatsApp takes files up to about this size. */
const SEND_MAX = 64 * 1024 * 1024;
const RECEIVE_MAX = 64 * 1024 * 1024;

/** The parts of a WhatsApp message this server reads. */
export interface WaMessage {
  key: {
    remoteJid?: string | null;
    remoteJidAlt?: string | null;
    fromMe?: boolean | null;
    id?: string | null;
    participant?: string | null;
  };
  message?: Record<string, unknown> | null;
  messageTimestamp?: number | { toNumber(): number } | null;
}

/** The parts of a Baileys socket this server uses; tests hand in their own. */
export interface WaSocket {
  ev: {
    on(
      event: 'connection.update',
      fn: (u: { connection?: string; qr?: string; lastDisconnect?: { error?: unknown } }) => void,
    ): void;
    on(event: 'creds.update', fn: (u: Record<string, unknown>) => void): void;
    on(event: 'messages.upsert', fn: (u: { type: string; messages: WaMessage[] }) => void): void;
  };
  user?: { id: string; lid?: string; name?: string } | null;
  sendMessage(
    jid: string,
    content: Record<string, unknown>,
  ): Promise<{ key?: { id?: string | null } } | undefined>;
  sendPresenceUpdate(type: 'composing' | 'paused', jid: string): Promise<void>;
  logout(): Promise<void>;
  end(err?: Error): void;
  signalRepository?: { lidMapping?: { getPNForLID(lid: string): Promise<string | null | undefined> } };
}

/** What the server needs from Baileys; loaded only when WhatsApp is used. */
export interface WaLibrary {
  connect(auth: unknown): WaSocket;
  initAuthCreds(): Record<string, unknown>;
  replacer: (k: string, v: unknown) => unknown;
  reviver: (k: string, v: unknown) => unknown;
  /** Turns a stored app-state key back into what Baileys expects. */
  appStateKey(value: unknown): unknown;
  download(m: WaMessage): Promise<Readable>;
  loggedOut: number;
}

async function baileys(): Promise<WaLibrary> {
  const wa = await import('@whiskeysockets/baileys');
  const makeWASocket = wa.default;
  // Baileys logs a great deal through pino; none of it is wanted here.
  const quiet = {
    level: 'silent',
    child: () => quiet,
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
  };
  return {
    connect: (auth) =>
      makeWASocket({
        auth: auth as never,
        logger: quiet as never,
        browser: ['Yumak Bot', 'Chrome', '1.0'],
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        markOnlineOnConnect: false,
        getMessage: async () => undefined,
        // Groups, status updates and channels are never read.
        shouldIgnoreJid: (jid: string) =>
          jid === 'status@broadcast' ||
          jid.endsWith('@g.us') ||
          jid.endsWith('@newsletter') ||
          jid.endsWith('@broadcast'),
      }) as unknown as WaSocket,
    initAuthCreds: () => wa.initAuthCreds() as unknown as Record<string, unknown>,
    replacer: wa.BufferJSON.replacer,
    reviver: wa.BufferJSON.reviver,
    appStateKey: (v) => wa.proto.Message.AppStateSyncKeyData.fromObject(v as never),
    download: (m) => wa.downloadMediaMessage(m as never, 'stream', {}) as Promise<Readable>,
    loggedOut: wa.DisconnectReason.loggedOut,
  };
}

/** `905321234567:12@s.whatsapp.net` → `905321234567`; null for anything that is not a number's address. */
const numberOf = (jid: string | null | undefined) =>
  /^(\d+)(?::\d+)?@s\.whatsapp\.net$/.exec(jid ?? '')?.[1] ?? null;
const bareJid = (jid: string) => jid.replace(/:\d+@/, '@');

/** The text and the kind of file a WhatsApp message carries, and whether it was forwarded. */
export function contentOf(m: WaMessage): {
  text: string;
  media: { kind: string; mime?: string; name?: string; size?: number } | null;
  forwarded: boolean;
} {
  let msg = (m.message ?? {}) as Record<string, Record<string, unknown> | undefined>;
  // Disappearing and view-once messages wrap the real one.
  for (const wrap of [
    'ephemeralMessage',
    'viewOnceMessage',
    'viewOnceMessageV2',
    'documentWithCaptionMessage',
  ]) {
    const inner = msg[wrap]?.message as typeof msg | undefined;
    if (inner) msg = inner;
  }
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const size = (v: unknown) =>
    typeof v === 'number' ? v : typeof v === 'object' && v ? Number(v) : undefined;
  const text = str(msg.conversation) || str(msg.extendedTextMessage?.text);
  // A forward is someone else's words, whichever account passed it on.
  const forwarded = Object.values(msg).some((part) => {
    const info = part?.contextInfo as { isForwarded?: unknown; forwardingScore?: unknown } | undefined;
    return (
      info?.isForwarded === true || (typeof info?.forwardingScore === 'number' && info.forwardingScore > 0)
    );
  });
  for (const [field, kind] of [
    ['imageMessage', 'photo'],
    ['documentMessage', 'document'],
    ['audioMessage', 'audio'],
    ['videoMessage', 'video'],
  ] as const) {
    const f = msg[field];
    if (!f) continue;
    const voice = field === 'audioMessage' && f.ptt === true;
    return {
      text: text || str(f.caption),
      media: {
        kind: voice ? 'voice' : kind,
        mime: str(f.mimetype) || undefined,
        name: str(f.fileName) || undefined,
        size: size(f.fileLength),
      },
      forwarded,
    };
  }
  return { text, media: null, forwarded };
}

/**
 * WhatsApp through a linked device, the way WhatsApp Web links: the person scans a QR code with
 * the account that will carry the messages. With their own number they write to the bots in
 * "Message yourself"; with a separate number they write to it from their own, and nobody else is
 * read. Messages go to one bot at a time, and `/bot <name>` changes which.
 */
export class WhatsAppChannel {
  /** How Baileys is reached; tests replace it. */
  library: () => Promise<WaLibrary> = baileys;
  private lib: WaLibrary | null = null;
  private socket: WaSocket | null = null;
  private state: WhatsAppStatus['state'] = 'off';
  private qr: string | null = null;
  private linkTimer: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  private attempt = 0;
  /** Messages this server sent, so its own words in "Message yourself" are not read as the person's. */
  private sentIds = new Set<string>();
  /** The last message sent here, and the one that ended the last card's choices. */
  private lastSent: string | null = null;
  private cardLast: string | null = null;
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
    const row = await this.row();
    const creds = await this.key('creds');
    if (row && creds && (JSON.parse(creds) as { registered?: boolean; me?: unknown }).me) {
      await this.open().catch((err: unknown) => this.fail(errorText(err)));
    }
  }

  async stop() {
    this.stopped = true;
    for (const u of this.unsubs) u();
    this.clearTimers();
    for (const timer of this.typing.values()) clearInterval(timer);
    this.typing.clear();
    await this.sends.drain();
    this.socket?.end();
    this.socket = null;
  }

  // The app's side

  async status(): Promise<WhatsAppStatus> {
    const row = await this.row();
    const s = (row?.settings ?? {}) as Settings;
    return {
      state: row ? this.state : 'off',
      mode: s.mode ?? null,
      phone: s.phone ?? null,
      botId: row?.botId ?? null,
      notices: s.notices !== false,
      linked: (row?.account as { number?: string } | undefined)?.number ?? null,
      qr: this.state === 'linking' && this.qr ? await qrImage(this.qr) : null,
      error: row?.error ?? null,
    };
  }

  async configure(input: WhatsAppSet): Promise<WhatsAppStatus> {
    if (input.botId) await this.services.bots.get(input.botId);
    const row = await this.row();
    const settings: Settings = {
      ...((row?.settings ?? {}) as Settings),
      mode: input.mode,
      phone: input.phone,
      notices: input.notices,
    };
    if (row) {
      await this.ctx.db
        .update(schema.channels)
        .set({ settings, botId: input.botId })
        .where(eq(schema.channels.id, row.id));
    } else {
      await this.ctx.db
        .insert(schema.channels)
        .values({ id: newId(), kind: 'whatsapp', botId: input.botId, settings });
    }
    this.changed();
    return this.status();
  }

  /** Starts over with a new device: the QR code to scan comes in the status. */
  async link(): Promise<WhatsAppStatus> {
    const row = await this.row();
    if (!row || !(row.settings as Settings).phone) throw new HttpError(409, 'error.whatsappNotSetUp');
    await this.close();
    await this.ctx.db.delete(schema.whatsappKeys);
    await this.ctx.db
      .update(schema.channels)
      .set({ account: {}, error: null })
      .where(eq(schema.channels.id, row.id));
    this.state = 'linking';
    this.qr = null;
    try {
      await this.open();
    } catch (err) {
      this.state = 'error';
      throw new HttpError(502, 'error.whatsappUnavailable', { message: errorText(err) });
    }
    this.linkTimer = setTimeout(() => {
      if (this.state === 'linking') void this.close().then(() => this.fail('expired'));
    }, LINK_MS);
    this.linkTimer.unref?.();
    this.changed();
    return this.status();
  }

  /** Unlinks the device (WhatsApp shows it gone from Linked Devices) and forgets its keys. */
  async disconnect(): Promise<WhatsAppStatus> {
    const socket = this.socket;
    this.socket = null;
    this.clearTimers();
    if (socket) {
      await socket.logout().catch(() => {});
      socket.end();
    }
    await this.ctx.db.delete(schema.whatsappKeys);
    await this.ctx.db.delete(schema.channels).where(eq(schema.channels.kind, 'whatsapp'));
    this.state = 'off';
    this.qr = null;
    this.changed();
    return this.status();
  }

  // The connection

  private async open() {
    if (this.stopped) return;
    this.lib ??= await this.library();
    const lib = this.lib;
    const saved = await this.key('creds');
    const creds = saved ? (JSON.parse(saved, lib.reviver) as Record<string, unknown>) : lib.initAuthCreds();
    if (!saved) await this.setKeys({ creds: JSON.stringify(creds, lib.replacer) });
    const auth = {
      creds,
      keys: {
        get: async (type: string, ids: string[]) => {
          const out: Record<string, unknown> = {};
          for (const id of ids) {
            const v = await this.key(`${type}:${id}`);
            if (v === null) continue;
            const value = JSON.parse(v, lib.reviver) as unknown;
            out[id] = type === 'app-state-sync-key' ? lib.appStateKey(value) : value;
          }
          return out;
        },
        set: async (data: Record<string, Record<string, unknown> | undefined>) => {
          const values: Record<string, string | null> = {};
          for (const [type, entries] of Object.entries(data)) {
            for (const [id, value] of Object.entries(entries ?? {})) {
              values[`${type}:${id}`] = value == null ? null : JSON.stringify(value, lib.replacer);
            }
          }
          await this.setKeys(values);
        },
      },
    };
    if (this.state !== 'linking') this.state = 'connecting';
    const socket = lib.connect(auth);
    this.socket = socket;
    socket.ev.on('creds.update', (update) => {
      if (this.socket !== socket) return;
      Object.assign(creds, update);
      void this.setKeys({ creds: JSON.stringify(creds, lib.replacer) }).catch(() => {});
    });
    socket.ev.on('connection.update', (u) => {
      if (this.socket !== socket) return;
      void this.connection(socket, u).catch((err: unknown) => console.warn('whatsapp', err));
    });
    socket.ev.on('messages.upsert', (u) => {
      if (this.socket !== socket || u.type !== 'notify') return;
      for (const m of u.messages) {
        void this.received(socket, m).catch((err: unknown) => console.warn('whatsapp message', err));
      }
    });
  }

  private async connection(
    socket: WaSocket,
    u: { connection?: string; qr?: string; lastDisconnect?: { error?: unknown } },
  ) {
    if (u.qr && this.state === 'linking') {
      this.qr = u.qr;
      this.changed();
    }
    if (u.connection === 'open') {
      const own = numberOf(socket.user?.id);
      const row = await this.row();
      const settings = (row?.settings ?? {}) as Settings;
      if (row && own && settings.mode === 'separate' && own === settings.phone) {
        // With "separate number" the linked account must not be the person's own.
        await this.close();
        await this.ctx.db.delete(schema.whatsappKeys);
        return this.fail('ownNumber');
      }
      if (row) {
        await this.ctx.db
          .update(schema.channels)
          .set({ account: { number: own, lid: socket.user?.lid ?? null }, error: null })
          .where(eq(schema.channels.id, row.id));
      }
      this.state = 'connected';
      this.qr = null;
      this.attempt = 0;
      if (this.linkTimer) clearTimeout(this.linkTimer);
      this.linkTimer = null;
      this.changed();
    }
    if (u.connection === 'close') {
      const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
        ?.statusCode;
      this.socket = null;
      if (code === this.lib?.loggedOut) {
        // Removed from Linked Devices on the phone: its keys are useless now.
        await this.ctx.db.delete(schema.whatsappKeys);
        return this.fail('loggedOut');
      }
      if (this.stopped) return;
      // A link that was just scanned asks for a restart; any other drop is tried again, slower each time.
      const wait = this.state === 'linking' ? 0 : Math.min(60_000, 1000 * 2 ** Math.min(this.attempt++, 6));
      if (this.state !== 'linking') this.state = 'connecting';
      this.changed();
      this.retry = setTimeout(() => {
        void this.open().catch((err: unknown) => this.fail(errorText(err)));
      }, wait);
      this.retry.unref?.();
    }
  }

  private async fail(error: string) {
    this.state = 'error';
    this.qr = null;
    const row = await this.row();
    if (row) await this.ctx.db.update(schema.channels).set({ error }).where(eq(schema.channels.id, row.id));
    this.changed();
  }

  private async close() {
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    socket?.end();
  }

  private clearTimers() {
    if (this.linkTimer) clearTimeout(this.linkTimer);
    if (this.retry) clearTimeout(this.retry);
    this.linkTimer = null;
    this.retry = null;
  }

  // Reading WhatsApp

  /** The address to answer at when the message is the person's own; null for anyone else's. */
  private async from(socket: WaSocket, m: WaMessage, settings: Settings): Promise<string | null> {
    const jid = m.key.remoteJid;
    if (!jid || m.key.participant || !/@(s\.whatsapp\.net|lid)$/.test(jid)) return null;
    let phone = numberOf(jid);
    if (!phone && jid.endsWith('@lid')) {
      phone = numberOf(m.key.remoteJidAlt);
      if (
        !phone &&
        settings.mode === 'own' &&
        socket.user?.lid &&
        bareJid(jid) === bareJid(socket.user.lid)
      ) {
        phone = numberOf(socket.user.id);
      }
      phone ??= numberOf(await socket.signalRepository?.lidMapping?.getPNForLID(jid).catch(() => null));
    }
    if (!phone) return null;
    if (settings.mode === 'own') {
      // Only "Message yourself", and only what the person typed there, not this server's replies.
      if (phone !== numberOf(socket.user?.id) || !m.key.fromMe) return null;
      if (m.key.id && this.sentIds.has(m.key.id)) return null;
    } else if (phone !== settings.phone || m.key.fromMe) {
      return null;
    }
    return bareJid(jid);
  }

  private async received(socket: WaSocket, m: WaMessage) {
    const row = await this.row();
    if (!row) return;
    const settings = row.settings as Settings;
    const jid = await this.from(socket, m, settings);
    if (!jid) return;
    const t = await this.services.settings.translator();
    const { text: raw, media, forwarded } = contentOf(m);
    const text = raw.trim();
    // `/bot` names the bot the messages go to; a forwarded `/bot` is only text.
    const pick = forwarded ? null : /^\/bot(?:\s+(.+))?$/i.exec(text);
    if (pick) {
      await this.pickBot(jid, row, pick[1]?.trim(), t);
      return;
    }
    const bot = row.botId ? await this.services.bots.get(row.botId).catch(() => null) : null;
    if (!bot) {
      await this.say(jid, t('channel.noBot'));
      return;
    }
    if (bot.archivedAt) {
      await this.say(jid, t('channel.botArchived'));
      return;
    }
    const thread = await this.services.threads.main(bot.id);
    if (!media && !forwarded) {
      const done = await chatCommand(this.services, thread.id, text, t);
      if (done) {
        await this.say(jid, done);
        return;
      }
      // A number answers the card when the card is the last thing sent here, the way a button
      // would; "always allow" takes the number and a word, so a stray digit never keeps a rule.
      const word = t('channel.alwaysWord').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const numbered = new RegExp(`^(\\d{1,2})(?:\\s+(${word}))?$`, 'iu').exec(text);
      if (numbered && (await this.answeredCard(jid, thread.id, Number(numbered[1]), !!numbered[2], t)))
        return;
    }
    const files: string[] = [];
    if (media) {
      const name = receivedName(media.kind, m.key.id ?? newId().slice(0, 8), media.mime, media.name);
      if ((media.size ?? 0) > RECEIVE_MAX) {
        await this.say(jid, t('channel.fileTooLarge', { name }));
      } else {
        try {
          const body = await this.lib!.download(m);
          files.push((await saveUpload(stagingDir(this.ctx.config.dataDir, thread.id), name, body)).name);
        } catch (err) {
          console.warn('whatsapp file', errorText(err));
          await this.say(jid, t('channel.fileFailed', { name }));
        }
      }
    }
    if (!text && !files.length) return;
    await this.saveSettings(row, { threadId: thread.id });
    await this.services.inbox.send(thread.id, {
      text,
      files,
      clientId: `whatsapp:${(m.key.id ?? newId()).slice(0, 48)}`,
      props: { via: 'whatsapp', ...(forwarded && { outside: 'forward' }) },
    });
  }

  private async pickBot(jid: string, row: Row, name: string | undefined, t: T) {
    const bots = (await this.services.bots.list()).filter((b) => !b.archivedAt);
    const names = bots.map((b) => b.name).join(', ');
    if (!name) {
      const current = bots.find((b) => b.id === row.botId);
      await this.say(
        jid,
        current ? t('channel.current', { bot: current.name, bots: names }) : t('channel.noBot'),
      );
      return;
    }
    const want = name.toLocaleLowerCase('tr');
    const bot: Bot | undefined =
      bots.find((b) => b.name.toLocaleLowerCase('tr') === want) ??
      bots.find((b) => b.name.toLocaleLowerCase('tr').startsWith(want));
    if (!bot) {
      await this.say(jid, t('channel.unknownBot', { name, bots: names }));
      return;
    }
    await this.ctx.db.update(schema.channels).set({ botId: bot.id }).where(eq(schema.channels.id, row.id));
    this.changed();
    await this.say(jid, t('channel.switched', { bot: bot.name }));
  }

  /**
   * Answers the card the numbered choices were sent for, when it is still open and nothing was
   * sent here after it. `always`: the person wrote the word for "always allow" after the number,
   * which alone keeps a rule; a bare number for that choice is answered with how to write it.
   */
  private async answeredCard(
    jid: string,
    threadId: string,
    n: number,
    always: boolean,
    t: T,
  ): Promise<boolean> {
    const row = await this.row();
    const card = (row?.settings as { card?: { threadId: string; choices: string[] } } | undefined)?.card;
    if (!this.cardLast || this.lastSent !== this.cardLast) return false;
    const data = card && card.threadId === threadId ? card.choices[n - 1] : undefined;
    if (!data) return false;
    const [kind, approvalId, value] = data.split(':') as ['a' | 'q', string, string];
    const approval = await this.services.approvals.get(approvalId).catch(() => null);
    if (!approval || approval.status !== 'pending') return false;
    if (always !== (kind === 'a' && value === 'r')) {
      if (always) return false;
      await this.say(jid, t('channel.alwaysByWord', { answer: `${n} ${t('channel.alwaysWord')}` }));
      // The card is still the one the next number answers.
      this.cardLast = this.lastSent;
      return true;
    }
    try {
      if (kind === 'a') {
        await this.services.approvals.answer(approvalId, {
          decision: value === 'n' ? 'deny' : 'allow',
          remember: value === 'r',
        });
      } else {
        const { items } = questionItems(approval);
        const option = items.length === 1 ? items[0]!.options[Number(value)] : undefined;
        if (!option) return false;
        await this.services.approvals.answer(approvalId, {
          decision: 'allow',
          answer: option,
          remember: false,
        });
      }
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) return false;
      throw err;
    }
    return true;
  }

  // Writing to WhatsApp

  /** Where replies go: "Message yourself", or the person's own number. */
  private async chat(): Promise<{ row: Row; jid: string } | null> {
    const row = await this.row();
    if (!row || this.state !== 'connected' || !this.socket) return null;
    const settings = row.settings as Settings;
    const own = (row.account as { number?: string }).number;
    const number = settings.mode === 'own' ? own : settings.phone;
    return number ? { row, jid: `${number}@s.whatsapp.net` } : null;
  }

  private async outgoing(m: Message) {
    if (this.stopped || !['assistant', 'approval', 'error'].includes(m.role)) return;
    const target = await this.chat();
    if (!target) return;
    const { row, jid } = target;
    const settings = row.settings as Settings;
    const thread = await this.services.threads.row(m.threadId).catch(() => null);
    if (!thread) return;
    const here = settings.threadId === m.threadId && (await lastWroteVia(this.ctx, m.threadId, 'whatsapp'));
    const t = await this.services.settings.translator();
    // A routine's report is written in the routine's conversation and copied to the main one; the
    // copy is the one sent, so it arrives once.
    const report = m.props.routineReport === true;
    const headed = () => `📋 **${String(m.props.routineName ?? '') || t('channel.routine')}**\n\n${m.text}`;
    // Turned off, routine reports stay in the app wherever the person talks from.
    if (report && settings.notices === false) return;
    if (!here) {
      if (settings.notices === false || thread.botId !== row.botId) return;
      if (!report || m.role !== 'assistant' || !m.text.trim()) return;
      await this.sends.run('wa', () => this.markdown(jid, headed()));
      return;
    }
    await this.sends.run('wa', async () => {
      if (m.role === 'approval') {
        const card = await this.services.approvals.get(String(m.props.approvalId)).catch(() => null);
        if (!card || card.status !== 'pending') return;
        const view = cardView(card, m.props, t);
        const how = (i: number) => t('channel.alwaysHow', { answer: `${i + 1} ${t('channel.alwaysWord')}` });
        const choices = view.buttons
          .map((b, i) => `${i + 1}. ${b.label}${b.data.endsWith(':r') ? ` (${how(i)})` : ''}`)
          .join('\n');
        await this.markdown(jid, choices ? `${view.text}\n\n${choices}` : view.text);
        // A number answers this card only while nothing else was sent after it.
        this.cardLast = this.lastSent;
        const latest = await this.row();
        if (latest) {
          await this.saveSettings(latest, {
            card: { threadId: m.threadId, choices: view.buttons.map((b) => b.data) },
          });
        }
        return;
      }
      if (m.role === 'error') return this.markdown(jid, `⚠️ ${m.text}`);
      if (m.author !== `bot:${thread.botId}`) return;
      if (m.text.trim()) await this.markdown(jid, report ? headed() : m.text);
      for (const f of messageFiles(m)) {
        const path = join(this.ctx.config.dataDir, 'workspaces', f.path);
        const size = await stat(path).then(
          (s) => s.size,
          () => -1,
        );
        // Inside the queue already: written straight away, not queued behind this job.
        if (size < 0 || size > SEND_MAX) {
          await this.markdown(jid, t('channel.fileInApp', { name: f.name }));
          continue;
        }
        try {
          await this.send(jid, { document: { url: path }, fileName: f.name, mimetype: mimeOf(f.name) });
        } catch (err) {
          console.warn('whatsapp send file', errorText(err));
          await this.markdown(jid, t('channel.fileInApp', { name: f.name }));
        }
      }
    });
  }

  private async markdown(jid: string, md: string) {
    for (const part of whatsappMessages(md)) await this.send(jid, { text: part });
  }

  /** A short line outside the order of replies (a command's answer). */
  private async say(jid: string, text: string) {
    await this.sends.run('wa', () => this.markdown(jid, text));
  }

  private async send(jid: string, content: Record<string, unknown>) {
    const socket = this.socket;
    if (!socket) return;
    const sent = await socket.sendMessage(jid, content);
    const id = sent?.key?.id;
    this.lastSent = id ?? newId();
    if (id) {
      this.sentIds.add(id);
      // Only recent ones matter: WhatsApp hands a sent message back at once.
      if (this.sentIds.size > 500) this.sentIds.delete(this.sentIds.values().next().value!);
    }
  }

  private async turnState(e: TurnEvent) {
    const target = await this.chat();
    const settings = (target?.row.settings ?? {}) as Settings;
    const active =
      !!target &&
      settings.threadId === e.threadId &&
      (e.state === 'running' || e.state === 'queued') &&
      (await lastWroteVia(this.ctx, e.threadId, 'whatsapp'));
    const timer = this.typing.get(e.threadId);
    if (!active) {
      if (timer) {
        clearInterval(timer);
        this.typing.delete(e.threadId);
        if (target) void this.socket?.sendPresenceUpdate('paused', target.jid).catch(() => {});
      }
      return;
    }
    if (timer || this.stopped) return;
    const send = () => void this.socket?.sendPresenceUpdate('composing', target.jid).catch(() => {});
    send();
    const next = setInterval(send, 8000);
    next.unref?.();
    this.typing.set(e.threadId, next);
  }

  private async notice(e: NoticeEvent) {
    if (this.stopped || e.kind === 'reply') return;
    const target = await this.chat();
    if (!target || target.row.botId !== e.botId) return;
    const settings = target.row.settings as Settings;
    if (settings.notices === false) return;
    // Its cards come as cards there, or the person is in the app with it.
    if (settings.threadId === e.threadId) return;
    const t = await this.services.settings.translator();
    const thread = await this.services.threads.row(e.threadId).catch(() => null);
    const title = thread?.title || t('channel.otherChat');
    await this.say(
      target.jid,
      t(e.kind === 'error' ? 'channel.noticeError' : 'channel.noticeNeedsYou', { title, text: e.text }),
    );
  }

  // Records

  private async row(): Promise<Row | null> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.channels)
      .where(eq(schema.channels.kind, 'whatsapp'))
      .limit(1);
    return row ?? null;
  }

  private async saveSettings(row: Row, patch: Record<string, unknown>) {
    const latest = (await this.row()) ?? row;
    await this.ctx.db
      .update(schema.channels)
      .set({ settings: { ...latest.settings, ...patch } })
      .where(eq(schema.channels.id, row.id));
  }

  private async key(key: string): Promise<string | null> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.whatsappKeys)
      .where(eq(schema.whatsappKeys.key, key))
      .limit(1);
    if (!row) return null;
    try {
      return this.vault.open(row.value);
    } catch {
      return null;
    }
  }

  private async setKeys(values: Record<string, string | null>) {
    for (const [key, value] of Object.entries(values)) {
      if (value === null) {
        await this.ctx.db.delete(schema.whatsappKeys).where(eq(schema.whatsappKeys.key, key));
        continue;
      }
      const sealed = this.vault.seal(value);
      await this.ctx.db
        .insert(schema.whatsappKeys)
        .values({ key, value: sealed })
        .onConflictDoUpdate({ target: schema.whatsappKeys.key, set: { value: sealed } });
    }
  }

  /** Keys of a kind, e.g. every session; only for tests and checks. */
  async keyCount(prefix = ''): Promise<number> {
    const rows = await this.ctx.db
      .select({ key: schema.whatsappKeys.key })
      .from(schema.whatsappKeys)
      .where(like(schema.whatsappKeys.key, `${prefix}%`));
    return rows.length;
  }

  private changed() {
    this.ctx.bus.refresh({ scope: 'channels' });
  }
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
