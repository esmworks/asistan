import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import {
  questionItems,
  type Bot,
  type Message,
  type NoticeEvent,
  type TurnEvent,
  type WhatsAppGroup,
  type WhatsAppSet,
  type WhatsAppStatus,
} from '@yumakbot/shared';
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  inArray,
  like,
  lt,
  lte,
  ne,
  not,
  notExists,
  or,
  sql,
} from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import type { ServerKey, T } from '../i18n';
import type { Services } from '../services';
import type { VaultService } from '../services/vault';
import { safeFileName, saveUpload, stagingDir } from '../uploads';
import { HttpError, newId, truncate } from '../util';
import {
  cardView,
  chatCommand,
  dropRequest,
  heldRequests,
  holdRequest,
  lastWroteVia,
  messageFiles,
  mimeOf,
  queuedTurn,
  receivedName,
  saidNothing,
  SendQueue,
  withMissingFiles,
} from './common';
import { whatsappMessages } from './format';
import { privateText } from './private-text';
import { qrImage } from './qr';

type Row = typeof schema.channels.$inferSelect;
type Settings = {
  mode?: WhatsAppSet['mode'];
  phone?: string;
  notices?: boolean;
  threadId?: string;
  /** When the newest message read here was written, in seconds: older ones handed again are not new. */
  seenAt?: number;
};

/**
 * How long a chat a routine reads stays quiet before its new messages go to the routine: one run
 * reads a whole exchange (a request and the photo after it) instead of one run for each line.
 */
const CHAT_QUIET_MS = 2 * 60_000;
/** The longest a batch waits in a chat that never goes quiet. */
const CHAT_MAX_WAIT_MS = 10 * 60_000;
/** Messages one batch carries; a run reading more would cost much and read little of it. */
const CHAT_BATCH_MAX = 200;
/** Text one batch carries at most, with the messages before it: a run must be able to read it all. */
const CHAT_BATCH_CHARS = 60_000;
/** Earlier messages of the chat a batch brings along, so the bot knows what was said before. */
const CHAT_CONTEXT = 20;
/** How much of one message's text is kept. */
const CHAT_TEXT_MAX = 4000;
/** How long the messages of chats routines read are kept. */
const CHAT_KEEP_MS = 30 * 24 * 3600_000;
/** How often what is older than that is dropped. */
const PRUNE_EVERY_MS = 6 * 3600_000;
/** Where a Status post goes. */
const STATUS_JID = 'status@broadcast';
/** How long the list of groups and their names is taken as current. */
const GROUP_NAMES_FRESH_MS = 10 * 60_000;

/** How old a message WhatsApp held while this device was away may be and still be answered. */
const HELD_MAX_S = 24 * 3600;

/** When a WhatsApp message was written, in seconds since the epoch; 0 when it does not say. */
export const stampOf = (m: WaMessage): number => {
  const v = m.messageTimestamp;
  const n = typeof v === 'number' ? v : v && typeof v === 'object' ? v.toNumber() : 0;
  return Number.isFinite(n) ? n : 0;
};

/** How long a QR setup may wait to be scanned before it is given up on. */
const LINK_MS = 5 * 60_000;
/** WhatsApp takes files up to about this size. */
const SEND_MAX = 64 * 1024 * 1024;
const RECEIVE_MAX = 64 * 1024 * 1024;
/** How long a reply waits for the connection to come back before it is given up on. */
const OFFLINE_WAIT_MS = 5 * 60_000;
/** Failed connection attempts in a row after which the person is told it keeps failing. */
const FAILING_AFTER = 12;
/** The least time between two posts to one chat; a burst from a dedicated number looks like spam. */
const PACE_MS = 1000;
/** How long the current WhatsApp Web version is looked up before the last known one is used. */
const VERSION_WAIT_MS = 5000;
const VERSION_FRESH_MS = 3600_000;
/** How many sent messages are kept for WhatsApp's resend requests, and for how long. */
const SENT_KEPT = 500;
const SENT_KEEP_MS = 24 * 3600_000;
/** Message ids already handled, so a message WhatsApp hands twice is answered once. */
const SEEN_KEPT = 1000;
/** Requests in the self chat that mean two bots are answering each other, and how long to pause. */
const LOOP_LIMITS = [
  { count: 30, ms: 10 * 60_000 },
  { count: 90, ms: 3600_000 },
];
const LOOP_PAUSE_MS = 10 * 60_000;
/** Keys of a device being linked live under this prefix until the link is saved. */
const LINK_NS = 'link/';
/** Keys that belong to no device: they survive a new link and an unlink. */
const META_NS = 'meta:';

/** A WhatsApp Web version as Baileys takes it. */
export type WaVersion = [number, number, number];

/** What the library is told when a socket is made. */
export interface WaConnectOptions {
  version?: WaVersion;
  /** The content of a message this device sent, for WhatsApp's resend requests. */
  getMessage(key: { id?: string | null }): Promise<Record<string, unknown> | undefined>;
  /** Chats whose messages are dropped before they are read: every group a routine does not follow. */
  ignore(jid: string): boolean;
}

/** The parts of a WhatsApp message this server reads. */
export interface WaMessage {
  key: {
    remoteJid?: string | null;
    remoteJidAlt?: string | null;
    fromMe?: boolean | null;
    id?: string | null;
    participant?: string | null;
    /** In a group, the writer's phone address when `participant` is a lid. */
    participantAlt?: string | null;
  };
  message?: Record<string, unknown> | null;
  messageTimestamp?: number | { toNumber(): number } | null;
  /** The name the writer gave themselves on WhatsApp. */
  pushName?: string | null;
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
    options?: { messageId?: string; statusJidList?: string[]; broadcast?: boolean },
  ): Promise<{ key?: { id?: string | null }; message?: Record<string, unknown> | null } | undefined>;
  /** The groups the account is in, by address; only read for the list a routine picks from. */
  groupFetchAllParticipating?: () => Promise<Record<string, { id: string; subject?: string | null }>>;
  /** Asks the phone to upload media again, for files whose link on WhatsApp's servers expired. */
  updateMediaMessage?: (m: WaMessage) => Promise<WaMessage>;
  sendPresenceUpdate(type: 'composing' | 'paused', jid: string): Promise<void>;
  logout(): Promise<void>;
  end(err?: Error): void;
  signalRepository?: { lidMapping?: { getPNForLID(lid: string): Promise<string | null | undefined> } };
}

/** What the server needs from Baileys; loaded only when WhatsApp is used. */
export interface WaLibrary {
  connect(auth: unknown, options: WaConnectOptions): WaSocket;
  /** The WhatsApp Web version now in use, or null when it cannot be found out. */
  latestVersion?(signal: AbortSignal): Promise<WaVersion | null>;
  initAuthCreds(): Record<string, unknown>;
  replacer: (k: string, v: unknown) => unknown;
  reviver: (k: string, v: unknown) => unknown;
  /** Turns a stored app-state key back into what Baileys expects. */
  appStateKey(value: unknown): unknown;
  download(m: WaMessage, socket: WaSocket): Promise<Readable>;
  /** `DisconnectReason` codes that end the connection for good or need their own words. */
  codes?: {
    forbidden: number;
    connectionReplaced: number;
    multideviceMismatch: number;
    restartRequired: number;
  };
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
    connect: (auth, options) =>
      makeWASocket({
        auth: auth as never,
        ...(options.version && { version: options.version }),
        logger: quiet as never,
        browser: ['Yumak Bot', 'Chrome', '1.0'],
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        markOnlineOnConnect: false,
        getMessage: async (key) => options.getMessage(key) as never,
        // Status updates and channels are never read, nor a group no routine follows.
        shouldIgnoreJid: (jid: string) =>
          jid === 'status@broadcast' ||
          jid.endsWith('@newsletter') ||
          jid.endsWith('@broadcast') ||
          options.ignore(jid),
      }) as unknown as WaSocket,
    initAuthCreds: () => wa.initAuthCreds() as unknown as Record<string, unknown>,
    replacer: wa.BufferJSON.replacer,
    reviver: wa.BufferJSON.reviver,
    appStateKey: (v) => wa.proto.Message.AppStateSyncKeyData.fromObject(v as never),
    latestVersion: async (signal) => {
      const found = await wa.fetchLatestWaWebVersion({ signal });
      return found.error || !found.isLatest ? null : (found.version as WaVersion);
    },
    // Old media whose link expired is asked of the phone again.
    download: (m, socket) =>
      wa.downloadMediaMessage(
        m as never,
        'stream',
        {},
        { reuploadRequest: socket.updateMediaMessage as never, logger: quiet as never },
      ) as Promise<Readable>,
    codes: {
      forbidden: wa.DisconnectReason.forbidden,
      connectionReplaced: wa.DisconnectReason.connectionReplaced,
      multideviceMismatch: wa.DisconnectReason.multideviceMismatch,
      restartRequired: wa.DisconnectReason.restartRequired,
    },
    loggedOut: wa.DisconnectReason.loggedOut,
  };
}

/** `905321234567:12@s.whatsapp.net` → `905321234567`; null for anything that is not a number's address. */
const numberOf = (jid: string | null | undefined) =>
  /^(\d+)(?::\d+)?@s\.whatsapp\.net$/.exec(jid ?? '')?.[1] ?? null;
const bareJid = (jid: string) => jid.replace(/:\d+@/, '@');

type WaMedia = { kind: string; mime?: string; name?: string; size?: number };

/**
 * The message a WhatsApp message answers: its id, its text and file, whether it was forwarded, and
 * the message itself.
 */
type WaQuoted = {
  id: string | null;
  text: string;
  media: WaMedia | null;
  forwarded: boolean;
  message: Record<string, unknown>;
};

/**
 * The text and the kind of file a WhatsApp message carries, whether it was forwarded, and the
 * message it answers when the person replied to one.
 */
export function contentOf(m: WaMessage): {
  text: string;
  media: WaMedia | null;
  forwarded: boolean;
  quoted: WaQuoted | null;
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
  // A reply names the message it answers and carries a copy of it.
  let quoted: WaQuoted | null = null;
  for (const part of Object.values(msg)) {
    const info = part?.contextInfo as { stanzaId?: unknown; quotedMessage?: unknown } | undefined;
    if (!info?.quotedMessage || typeof info.quotedMessage !== 'object') continue;
    const message = info.quotedMessage as Record<string, unknown>;
    const inner = contentOf({ key: {}, message });
    quoted = {
      id: typeof info.stanzaId === 'string' ? info.stanzaId : null,
      text: inner.text,
      media: inner.media,
      forwarded: inner.forwarded,
      message,
    };
    break;
  }
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
      quoted,
    };
  }
  return { text, media: null, forwarded, quoted };
}

/**
 * WhatsApp through a linked device, the way WhatsApp Web links: the person scans a QR code with
 * the account that will carry the messages. With their own number they write to the bots in
 * "Message yourself"; with a separate number they write to it from their own. Messages go to one
 * bot at a time, and `/bot <name>` changes which. Nobody else's chats are read unless a routine of
 * the person who linked WhatsApp reads them: people's chats with the account when one has that
 * switch on, and the groups one follows. Their messages are kept 30 days and start that routine as
 * outside text; a reply goes only once the person approves its draft, and nothing is ever written
 * to a group.
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
  /** Prefix of the keys in use: the link prefix while a new device is being linked, else none. */
  private ns = '';
  /** Whether a QR code was shown for the link in progress; a close before that is a dead connection. */
  private qrShown = false;
  /** Sends and the connection: sends wait here for the connection to come back. */
  private waiters = new Set<(ok: boolean) => void>();
  private gaveUp = false;
  /** A reply could not be delivered; the person is told once the connection allows. */
  private undelivered = false;
  /** Requests from WhatsApp being worked on, to end each once, and the ones to settle at the first connect. */
  private working = new Set<string>();
  private settlePending = false;
  /** Incoming messages are handled one at a time, in the order they came. */
  private reading: Promise<void> = Promise.resolve();
  private seen = new Set<string>();
  /** Writes of keys and creds go one after another; the newest creds win. */
  private writes: Promise<unknown> = Promise.resolve();
  private credsChain: Promise<void> = Promise.resolve();
  private credsDirty = false;
  private credsNow: (() => string) | null = null;
  /** What was sent lately, for WhatsApp's resend requests; kept in memory only. */
  private sentBodies = new Map<string, { message: Record<string, unknown>; at: number }>();
  private lastPost = new Map<string, number>();
  /** The least time between two posts to a chat; tests turn it off. */
  paceMs = PACE_MS;
  /** How long a QR code may wait to be scanned; tests shorten it. */
  linkMs = LINK_MS;
  private version: { value: WaVersion; at: number } | null = null;
  private requestTimes: number[] = [];
  /** Groups an enabled routine follows; every other group is dropped unread. */
  private followed = new Set<string>();
  /** Whether a routine reads what people write to the account in chats of their own. */
  private people = false;
  private groupNames = new Map<string, string>();
  private groupNamesAt = 0;
  /** Chats whose new messages wait for the chat to go quiet. */
  private waits = new Map<string, { startedAt: number; timer: NodeJS.Timeout | null }>();
  private pruneTimer: NodeJS.Timeout | null = null;
  /** How long a chat stays quiet before its batch goes out; tests shorten it. */
  chatQuietMs = CHAT_QUIET_MS;
  chatMaxWaitMs = CHAT_MAX_WAIT_MS;
  private pausedUntil = 0;
  /** When the person was last told a request waits out the pause. */
  private heldNoteAt = 0;

  constructor(
    private ctx: Ctx,
    private services: Services,
    private vault: VaultService,
  ) {}

  async start() {
    this.unsubs.push(this.services.threads.onMessage((m) => this.outgoing(m)));
    this.unsubs.push(this.ctx.bus.on('turn', (e) => void this.turnState(e).catch(() => {})));
    this.unsubs.push(this.ctx.bus.on('notice', (e) => void this.notice(e).catch(() => {})));
    this.unsubs.push(
      this.ctx.bus.on('refresh', (e) => {
        if (e.scope === 'routines') void this.loadFollowed().catch(() => {});
        if (e.scope === 'approvals')
          void this.settleDrafts().catch((err: unknown) => console.warn('whatsapp draft', err));
      }),
    );
    await this.loadFollowed();
    await this.prune().catch((err: unknown) => console.warn('whatsapp prune', err));
    this.pruneTimer = setInterval(
      () => void this.prune().catch((err: unknown) => console.warn('whatsapp prune', err)),
      PRUNE_EVERY_MS,
    );
    this.pruneTimer.unref();
    await this.resumeChats();
    // A link that was never finished leaves its keys behind; the device in use is untouched.
    await this.dropNs();
    const row = await this.row();
    const creds = await this.key('creds');
    if (row && creds && (JSON.parse(creds) as { registered?: boolean; me?: unknown }).me) {
      // A queued turn survives the restart and still runs, so its request stays; the others are
      // settled once the connection is open and the person can be written to.
      for (const h of await heldRequests(this.ctx, row.id)) {
        if (await queuedTurn(this.ctx, h.threadId)) this.working.add(h.threadId);
      }
      this.settlePending = true;
      await this.open().catch((err: unknown) => this.fail(errorText(err)));
    }
  }

  /** Requests that were being worked on when the server stopped are over: the person is told so they write again. */
  private async settleHeld(row: Row) {
    const t = await this.services.settings.translator();
    for (const h of await heldRequests(this.ctx, row.id)) {
      if (this.working.has(h.threadId)) continue;
      await dropRequest(this.ctx, row.id, h.threadId);
      const jid = (h.place as { jid?: string }).jid;
      if (jid) await this.say(jid, t('channel.cutShort'));
    }
  }

  async stop() {
    this.stopped = true;
    for (const u of this.unsubs) u();
    this.clearTimers();
    for (const timer of this.typing.values()) clearInterval(timer);
    this.typing.clear();
    // Sends waiting for the connection stop waiting.
    this.settle();
    await this.sends.drain();
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    // What waits for a quiet chat is in the store and goes out after the next start.
    for (const wait of this.waits.values()) if (wait.timer) clearTimeout(wait.timer);
    this.waits.clear();
    await this.reading;
    await this.credsChain;
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

  /** Sets the chat up for `userId`: what comes in through it is theirs. */
  async configure(input: WhatsAppSet, userId: string): Promise<WhatsAppStatus> {
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
        .set({ settings, botId: input.botId, userId })
        .where(eq(schema.channels.id, row.id));
    } else {
      await this.ctx.db
        .insert(schema.channels)
        .values({ id: newId(), kind: 'whatsapp', botId: input.botId, settings, userId });
    }
    this.changed();
    return this.status();
  }

  /**
   * Starts over with a new device: the QR code to scan comes in the status. The new device's keys
   * are kept apart until the scan is saved, so a code that is never scanned costs nothing: the
   * device that works now is brought back.
   */
  async link(): Promise<WhatsAppStatus> {
    const row = await this.row();
    if (!row || !(row.settings as Settings).phone) throw new HttpError(409, 'error.whatsappNotSetUp');
    await this.close();
    await this.flushCreds();
    await this.dropNs();
    this.ns = LINK_NS;
    this.qrShown = false;
    await this.ctx.db.update(schema.channels).set({ error: null }).where(eq(schema.channels.id, row.id));
    this.state = 'linking';
    this.qr = null;
    this.attempt = 0;
    try {
      await this.open();
    } catch (err) {
      await this.dropNs();
      this.ns = '';
      this.state = 'error';
      this.settle();
      throw new HttpError(502, 'error.whatsappUnavailable', { message: errorText(err) });
    }
    this.linkTimer = setTimeout(() => {
      if (this.state === 'linking') void this.abandonLink('expired', true).catch(() => {});
    }, this.linkMs);
    this.linkTimer.unref?.();
    this.changed();
    return this.status();
  }

  /**
   * A link that will not finish (the code expired, WhatsApp cannot be reached): its keys go and the
   * device that worked before is connected again; without one, the error is shown.
   */
  private async abandonLink(error: string, reconnect: boolean) {
    await this.close();
    await this.flushCreds();
    await this.dropNs();
    this.ns = '';
    this.qr = null;
    this.qrShown = false;
    const old = await this.key('creds');
    if (reconnect && old && (JSON.parse(old) as { me?: unknown }).me && !this.stopped) {
      this.state = 'connecting';
      this.changed();
      await this.open().catch((err: unknown) => this.fail(errorText(err)));
      return;
    }
    await this.fail(error);
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
    await this.flushCreds();
    await this.wipeKeys();
    this.ns = '';
    await this.ctx.db.delete(schema.channels).where(eq(schema.channels.kind, 'whatsapp'));
    this.state = 'off';
    this.qr = null;
    this.settle();
    this.changed();
    return this.status();
  }

  // The connection

  /**
   * The WhatsApp Web version to connect with: the current one when it can be found out in a few
   * seconds, else the last good one, else the library's own. WhatsApp turns old versions away.
   */
  private async webVersion(lib: WaLibrary): Promise<WaVersion | undefined> {
    if (!lib.latestVersion) return undefined;
    if (this.version && Date.now() - this.version.at < VERSION_FRESH_MS) return this.version.value;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), VERSION_WAIT_MS);
    try {
      const found = await Promise.race([
        lib.latestVersion(abort.signal),
        new Promise<null>((resolve) => abort.signal.addEventListener('abort', () => resolve(null))),
      ]);
      if (found) {
        this.version = { value: found, at: Date.now() };
        await this.setKeys({ [`${META_NS}version`]: JSON.stringify(found) }, true).catch(() => {});
        return found;
      }
    } catch (err) {
      console.warn('whatsapp version', errorText(err));
    } finally {
      clearTimeout(timer);
    }
    if (this.version) return this.version.value;
    const kept = await this.key(`${META_NS}version`, '').catch(() => null);
    try {
      const value = kept ? (JSON.parse(kept) as WaVersion) : null;
      if (Array.isArray(value) && value.length === 3 && value.every((n) => Number.isInteger(n))) {
        this.version = { value, at: 0 };
        return value;
      }
    } catch {
      // A stored version that cannot be read is as good as none.
    }
    return undefined;
  }

  private async open() {
    if (this.stopped) return;
    this.lib ??= await this.library();
    const lib = this.lib;
    // What the scan wrote must be on disk before it is read back for the restart that follows.
    await this.flushCreds();
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
    const version = await this.webVersion(lib);
    if (this.stopped) return;
    const socket = lib.connect(auth, {
      ...(version && { version }),
      getMessage: async (key) => this.sentMessage(key.id),
      ignore: (jid) => jid.endsWith('@g.us') && !this.followed.has(jid),
    });
    this.socket = socket;
    socket.ev.on('creds.update', (update) => {
      if (this.socket !== socket) return;
      Object.assign(creds, update);
      this.credsNow = () => JSON.stringify(creds, lib.replacer);
      this.credsDirty = true;
      void this.flushCreds();
    });
    socket.ev.on('connection.update', (u) => {
      if (this.socket !== socket) return;
      void this.connection(socket, u).catch((err: unknown) => console.warn('whatsapp', err));
    });
    socket.ev.on('messages.upsert', (u) => {
      // New messages come as `notify`. Ones WhatsApp held while this device was away may come as
      // `append` after it connects again; those are read only when newer than the last one read.
      if (this.socket !== socket || (u.type !== 'notify' && u.type !== 'append')) return;
      for (const m of u.messages) {
        this.reading = this.reading
          .then(() => this.received(socket, m, u.type === 'append'))
          .catch((err: unknown) => console.warn('whatsapp message', err));
      }
    });
  }

  /** Writes the newest creds; one write at a time, in the order asked, and a failure is logged. */
  private flushCreds(): Promise<void> {
    this.credsChain = this.credsChain.then(async () => {
      if (!this.credsDirty || !this.credsNow) return;
      this.credsDirty = false;
      try {
        await this.setKeys({ creds: this.credsNow() });
      } catch (err) {
        console.warn('whatsapp creds', errorText(err));
      }
    });
    return this.credsChain;
  }

  /** What `connection.update` said about why the connection closed. */
  private async closed(code: number | undefined) {
    const codes = this.lib?.codes;
    const linking = this.state === 'linking';
    this.socket = null;
    const final = (error: string) => (linking ? this.abandonLink(error, false) : this.fail(error));
    if (code === this.lib?.loggedOut) {
      // Removed from Linked Devices on the phone: its keys are useless now.
      if (linking) return this.abandonLink('loggedOut', false);
      await this.wipeKeys();
      return this.fail('loggedOut');
    }
    if (code !== undefined && codes) {
      if (code === codes.forbidden) return final('forbidden');
      if (code === codes.multideviceMismatch) return final('mismatch');
      // The number was opened somewhere else; taking it back would only start a tug of war.
      if (code === codes.connectionReplaced) return final('replaced');
    }
    if (this.stopped) return;
    // A link that was just scanned asks for a restart at once; any other drop is tried again, slower each time.
    const restart = code !== undefined && code === codes?.restartRequired;
    if (linking && !restart && !this.qrShown) return this.abandonLink('unreachable', true);
    const wait = restart ? 0 : Math.min(linking ? 10_000 : 60_000, 1000 * 2 ** Math.min(this.attempt++, 6));
    if (!linking) this.state = 'connecting';
    this.changed();
    if (this.attempt >= FAILING_AFTER) {
      const row = await this.row();
      if (row && row.error !== 'failing') {
        await this.ctx.db
          .update(schema.channels)
          .set({ error: 'failing' })
          .where(eq(schema.channels.id, row.id));
        this.changed();
      }
    }
    this.retry = setTimeout(() => {
      void this.open().catch((err: unknown) => this.fail(errorText(err)));
    }, wait);
    this.retry.unref?.();
  }

  private async connection(
    socket: WaSocket,
    u: { connection?: string; qr?: string; lastDisconnect?: { error?: unknown } },
  ) {
    if (u.qr && this.state === 'linking') {
      this.qr = u.qr;
      this.qrShown = true;
      this.changed();
    }
    if (u.connection === 'open') {
      const own = numberOf(socket.user?.id);
      const row = await this.row();
      const settings = (row?.settings ?? {}) as Settings;
      if (row && own && settings.mode === 'separate' && own === settings.phone) {
        // With "separate number" the linked account must not be the person's own.
        await this.close();
        if (this.state === 'linking') {
          await this.dropNs();
          this.ns = '';
        } else {
          await this.wipeKeys();
        }
        return this.fail('ownNumber');
      }
      if (this.state === 'linking') await this.promote();
      if (row) {
        await this.ctx.db
          .update(schema.channels)
          .set({ account: { number: own, lid: socket.user?.lid ?? null }, error: null })
          .where(eq(schema.channels.id, row.id));
      }
      this.state = 'connected';
      this.qr = null;
      this.attempt = 0;
      this.gaveUp = false;
      if (this.linkTimer) clearTimeout(this.linkTimer);
      this.linkTimer = null;
      this.settle();
      this.changed();
      if (row && this.settlePending) {
        this.settlePending = false;
        void this.settleHeld(row).catch((err: unknown) => console.warn('whatsapp held', err));
      }
      void this.tellUndelivered().catch(() => {});
      // Replies approved while the connection was down go now.
      void this.settleDrafts().catch((err: unknown) => console.warn('whatsapp draft', err));
    }
    if (u.connection === 'close') {
      const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
        ?.statusCode;
      await this.closed(code);
    }
  }

  private async fail(error: string) {
    // The reason is saved before the state shows it, so no one sees a stopped chat without one.
    const row = await this.row();
    if (row) await this.ctx.db.update(schema.channels).set({ error }).where(eq(schema.channels.id, row.id));
    this.state = 'error';
    this.qr = null;
    this.settle();
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

  /** Wakes the sends waiting for the connection: it came back, or it will not. */
  private settle() {
    for (const w of [...this.waiters]) w(true);
  }

  /**
   * The open socket, waiting for it to come back when the connection dropped; null when it does not
   * (the chat was stopped, it failed for good, or the wait ran out). Once a wait has run out, later
   * sends do not wait again until the connection is back, so a long outage does not hold every reply
   * for its own five minutes.
   */
  private async online(): Promise<WaSocket | null> {
    const ready = () => (this.state === 'connected' && this.socket ? this.socket : null);
    if (ready()) return ready();
    if (this.stopped || this.gaveUp || this.state === 'off' || this.state === 'error') return null;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(() => {
        this.gaveUp = true;
        done();
      }, OFFLINE_WAIT_MS);
      timer.unref?.();
      this.waiters.add(done);
    });
    return ready();
  }

  // Reading WhatsApp

  /** The address to answer at when the message is the person's own; null for anyone else's. */
  private async from(
    socket: WaSocket,
    m: WaMessage,
    settings: Settings,
    channelId: string,
  ): Promise<string | null> {
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
      // Remembered in memory for the moment after a send, and in the records for after a restart.
      if (m.key.id && (this.sentIds.has(m.key.id) || (await this.ours(channelId, m.key.id)))) return null;
    } else if (phone !== settings.phone || m.key.fromMe) {
      return null;
    }
    return bareJid(jid);
  }

  private async received(socket: WaSocket, m: WaMessage, held = false) {
    const row = await this.row();
    if (!row) return;
    const settings = row.settings as Settings;
    // A followed group's messages never reach the person's chat with the bots, its commands or its cards.
    const remote = m.key.remoteJid;
    if (remote?.endsWith('@g.us')) {
      if (this.followed.has(remote)) await this.chatMessage(socket, m, remote, 'group');
      return;
    }
    const jid = await this.from(socket, m, settings, row.id);
    if (!jid) {
      // Someone else's chat with the account: read only when a routine reads people's chats.
      if (!this.people) return;
      const chat = await this.personChat(socket, m, settings);
      if (chat) await this.chatMessage(socket, m, chat, 'person');
      return;
    }
    // Before any command or download: a message WhatsApp hands again must not run twice.
    const id = m.key.id;
    if (id) {
      if (this.seen.has(id) || (await this.ours(row.id, id))) return;
      this.seen.add(id);
      if (this.seen.size > SEEN_KEPT) this.seen.delete(this.seen.values().next().value!);
    }
    const stamp = stampOf(m);
    if (held) {
      // Only what came after the last message read, and not long ago: never old history.
      const seen = settings.seenAt ?? 0;
      if (!seen || stamp <= seen || Date.now() / 1000 - stamp > HELD_MAX_S) return;
    }
    try {
      await this.handle(socket, row, jid, m, stamp);
    } catch (err) {
      console.warn('whatsapp message', err);
      const t = await this.services.settings.translator();
      await this.say(jid, t('channel.updateFailed')).catch(() => {});
    }
  }

  // Chats routines read: people who write to the account, and followed groups

  private async loadFollowed() {
    const reads = await this.services.routines.whatsappReads();
    this.followed = reads.groups;
    this.people = reads.people;
    // A chat no longer read keeps what was stored, but no batch goes out for it.
    for (const [jid, wait] of this.waits) {
      if (jid.endsWith('@g.us') ? this.followed.has(jid) : this.people) continue;
      if (wait.timer) clearTimeout(wait.timer);
      this.waits.delete(jid);
    }
  }

  /** Whose WhatsApp is linked: who set it up; null when it is not set up. */
  async ownerId(): Promise<string | null> {
    return (await this.row())?.userId ?? null;
  }

  /** The groups the linked account is in, for a routine to pick the one it follows. */
  async groups(): Promise<WhatsAppGroup[]> {
    const socket = this.state === 'connected' ? this.socket : null;
    if (!socket?.groupFetchAllParticipating) throw new HttpError(409, 'error.whatsappNotConnected');
    await this.loadGroupNames(socket, true);
    return [...this.groupNames]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private async loadGroupNames(socket: WaSocket, force = false) {
    if (!force && Date.now() - this.groupNamesAt < GROUP_NAMES_FRESH_MS) return;
    const all = (await socket.groupFetchAllParticipating?.()) ?? {};
    this.groupNames = new Map(Object.values(all).map((g) => [g.id, oneLine(g.subject ?? '') || g.id]));
    this.groupNamesAt = Date.now();
  }

  private async groupName(socket: WaSocket, jid: string): Promise<string> {
    await this.loadGroupNames(socket).catch(() => {});
    return this.groupNames.get(jid) ?? '';
  }

  /** A phone number for an address: its own, or the one WhatsApp pairs with a lid. */
  private async phoneOf(socket: WaSocket, jid: string, alt?: string | null): Promise<string | null> {
    let phone = numberOf(jid) ?? numberOf(alt);
    if (!phone && jid.endsWith('@lid')) {
      if (socket.user?.lid && bareJid(jid) === bareJid(socket.user.lid)) phone = numberOf(socket.user.id);
      phone ??= numberOf(await socket.signalRepository?.lidMapping?.getPNForLID(jid).catch(() => null));
    }
    return phone;
  }

  /**
   * The chat of someone else writing to the account, under one address however WhatsApp names
   * them (a number, or a lid); null for the person's own chat with the bots and for anything else.
   */
  private async personChat(socket: WaSocket, m: WaMessage, settings: Settings): Promise<string | null> {
    const jid = m.key.remoteJid;
    if (!jid || m.key.participant || !/@(s\.whatsapp\.net|lid)$/.test(jid)) return null;
    const phone = await this.phoneOf(socket, jid, m.key.remoteJidAlt);
    // "Message yourself", and the person's own number when the bots have one of their own.
    if (phone && (phone === numberOf(socket.user?.id) || phone === settings.phone)) return null;
    return phone ? `${phone}@s.whatsapp.net` : bareJid(jid);
  }

  /** Who wrote a message in a chat: their WhatsApp name and number, as far as they are known. */
  private async writerOf(socket: WaSocket, m: WaMessage, chat: string, t: T): Promise<string> {
    if (m.key.fromMe) return t('whatsapp.groupYou');
    const who = m.key.participant ?? chat;
    const phone = await this.phoneOf(socket, who, m.key.participantAlt);
    const name = oneLine(m.pushName ?? '');
    if (name && phone) return `${name} (+${phone})`;
    return name || (phone ? `+${phone}` : '?');
  }

  /**
   * A message in a chat a routine reads: stored, and its chat's batch waits for the chat to go
   * quiet. Codes, passwords and sign-in links are dropped before anything is kept. The person's
   * own messages in the chat are kept as context but start nothing. Nothing is said back.
   */
  private async chatMessage(socket: WaSocket, m: WaMessage, chat: string, kind: 'person' | 'group') {
    const id = m.key.id;
    if (!id) return;
    const stamp = stampOf(m) || Math.floor(Date.now() / 1000);
    // Only what is new, not history WhatsApp hands over long after.
    if (Date.now() / 1000 - stamp > HELD_MAX_S) return;
    const { text: raw, media, forwarded, quoted } = contentOf(m);
    const text = raw.trim();
    if (!text && !media) return;
    // A code, a password or a sign-in link: none of it is kept, not even the file; a line without
    // its content says one was left out, so a payment worded like a code does not vanish unseen.
    const hidden =
      privateText(text) || (!!quoted && privateText(quoted.text)) || privateText(media?.name ?? '');
    // A code from someone with no chat here (a bank, a sign-in) leaves no trace at all.
    if (hidden && !(await this.knownChat(chat))) return;
    const t = await this.services.settings.translator();
    const writer = await this.writerOf(socket, m, chat, t);
    const name =
      kind === 'group' ? await this.groupName(socket, chat) : !m.key.fromMe ? oneLine(m.pushName ?? '') : '';
    const at = new Date(stamp * 1000);
    await this.ctx.db
      .insert(schema.whatsappChats)
      .values({ jid: chat, kind, name, lastAt: at })
      .onConflictDoUpdate({
        target: schema.whatsappChats.jid,
        set: { lastAt: at, ...(name && { name }) },
      });
    const quote =
      !hidden && quoted?.text.trim()
        ? `${t('whatsapp.groupQuote', { text: truncate(quoted.text.trim().replace(/\s+/g, ' '), 300) })}\n`
        : '';
    const [stored] = await this.ctx.db
      .insert(schema.whatsappMessages)
      .values({
        chat,
        externalId: id,
        fromMe: !!m.key.fromMe,
        hidden,
        writer: forwarded ? `${writer} ${t('whatsapp.groupForwarded')}` : writer,
        text: hidden ? t('whatsapp.hidden') : `${quote}${truncate(text, CHAT_TEXT_MAX)}`,
        at,
      })
      .onConflictDoNothing()
      .returning({ seq: schema.whatsappMessages.seq });
    // Handed again, or sent from here: already kept.
    if (!stored) return;
    if (hidden) return;
    if (media) {
      const name = receivedName(media.kind, id, media.mime, media.name);
      const file = await this.chatFile(socket, chat, kind, m, name, media.size);
      await this.ctx.db
        .update(schema.whatsappMessages)
        .set({ file })
        .where(eq(schema.whatsappMessages.seq, stored.seq));
    }
    // The person answering in the chat themselves holds the batch back until the chat is quiet.
    if (!m.key.fromMe || this.waits.has(chat)) this.waitForQuiet(chat);
  }

  /** Where a bot keeps a chat's files, inside its own folder. */
  private chatFolder(botId: string, chat: string) {
    const root = resolve(this.ctx.config.dataDir, 'workspaces');
    return join(root, 'bots', botId, 'files', 'whatsapp', chat.replace(/@.*$/, '').replace(/[^\w-]/g, '_'));
  }

  /** Saves a chat message's file under the same name in each reading bot's folder. */
  private async chatFile(
    socket: WaSocket,
    chat: string,
    kind: 'person' | 'group',
    m: WaMessage,
    name: string,
    size: number | undefined,
  ): Promise<{ name: string; size: number } | { failed: string }> {
    if ((size ?? 0) > RECEIVE_MAX) return { failed: 'whatsapp.groupFileTooLarge' };
    const bots = await this.services.routines.chatReaders(chat, kind);
    if (!bots.length) return { failed: 'whatsapp.groupFileFailed' };
    // The message id keeps two files of the same name apart.
    const file = `${(m.key.id ?? newId()).slice(0, 24)}-${safeFileName(name) || 'file'}`;
    try {
      const first = this.chatFolder(bots[0]!, chat);
      await mkdir(first, { recursive: true, mode: 0o700 });
      const saved = await saveUpload(first, file, await this.lib!.download(m, socket));
      const path = join(first, saved.name);
      for (const botId of bots.slice(1)) {
        await mkdir(this.chatFolder(botId, chat), { recursive: true, mode: 0o700 });
        await copyFile(path, join(this.chatFolder(botId, chat), saved.name));
      }
      return { name: saved.name, size: (await stat(path)).size };
    } catch (err) {
      console.warn('whatsapp chat file', errorText(err));
      return { failed: 'whatsapp.groupFileFailed' };
    }
  }

  /** Each new message waits for the chat to go quiet again, up to the longest wait from the first. */
  private waitForQuiet(chat: string, ms = this.chatQuietMs) {
    const wait = this.waits.get(chat) ?? { startedAt: Date.now(), timer: null };
    if (wait.timer) clearTimeout(wait.timer);
    const left = Math.max(0, Math.min(ms, wait.startedAt + this.chatMaxWaitMs - Date.now()));
    wait.timer = setTimeout(() => {
      this.reading = this.reading
        .then(() => this.handOver(chat))
        .catch((err: unknown) => console.warn('whatsapp chat', err));
    }, left);
    this.waits.set(chat, wait);
  }

  /** One message of a chat as a bot reads it, with its file in that bot's own folder. */
  private chatLine(row: typeof schema.whatsappMessages.$inferSelect, botId: string, t: T): string {
    const head = `[${row.at.toISOString()}] ${row.writer}: ${row.text}`.trimEnd();
    const file = row.file;
    if (!file) return head;
    if ('failed' in file) return `${head}\n  ${t(file.failed as ServerKey, { name: '' }).trim()}`;
    const path = join(this.chatFolder(botId, row.chat), file.name);
    return `${head}\n  ${t('whatsapp.groupFile', { path, size: file.size })}`;
  }

  /**
   * Hands a chat's new messages to the routines that read it, with the messages before them for
   * context. The chat's place in the store moves on only once every routine has the batch, so a
   * restart or a busy routine hands it again later instead of losing it.
   */
  private async handOver(chat: string) {
    this.waits.delete(chat);
    const [row] = await this.ctx.db
      .select()
      .from(schema.whatsappChats)
      .where(eq(schema.whatsappChats.jid, chat))
      .limit(1);
    if (!row) return;
    if (row.kind === 'group' ? !this.followed.has(chat) : !this.people) return;
    // A batch a busy routine did not take goes out again as it was, nothing added to it.
    const held = row.heldSeq !== null && row.heldSeq > row.batchedSeq ? row.heldSeq : null;
    const fresh = await this.ctx.db
      .select()
      .from(schema.whatsappMessages)
      .where(
        and(
          eq(schema.whatsappMessages.chat, chat),
          gt(schema.whatsappMessages.seq, row.batchedSeq),
          held !== null ? lte(schema.whatsappMessages.seq, held) : undefined,
        ),
      )
      .orderBy(asc(schema.whatsappMessages.seq))
      .limit(CHAT_BATCH_MAX + 1);
    if (!fresh.length) {
      if (held !== null) await this.moveOn(chat, row.batchedSeq, {}, null);
      return;
    }
    const batch = withinChars(fresh.slice(0, CHAT_BATCH_MAX), CHAT_BATCH_CHARS);
    const last = batch[batch.length - 1]!.seq;
    const more = fresh.length > batch.length || held !== null;
    // Only the person's own lines, or left-out ones: nothing to answer; they become context.
    if (batch.every((r) => r.fromMe || r.hidden)) {
      await this.moveOn(chat, last, {}, null);
      if (more) this.waitForQuiet(chat, 0);
      return;
    }
    const before = withinChars(
      await this.ctx.db
        .select()
        .from(schema.whatsappMessages)
        .where(and(eq(schema.whatsappMessages.chat, chat), lte(schema.whatsappMessages.seq, row.batchedSeq)))
        .orderBy(desc(schema.whatsappMessages.seq))
        .limit(CHAT_CONTEXT),
      Math.max(0, CHAT_BATCH_CHARS - batch.reduce((n, r) => n + lineChars(r), 0)),
      true,
    ).reverse();
    const t = await this.services.settings.translator();
    const title = row.name
      ? row.kind === 'person'
        ? `${row.name} (+${numberOf(chat) ?? chat})`
        : row.name
      : chat;
    const payloadFor = (botId: string) =>
      [
        t(row.kind === 'group' ? 'whatsapp.groupHeader' : 'whatsapp.chatHeader', { name: title }),
        t('whatsapp.chatId', { chat }),
        ...(before.length
          ? ['', t('whatsapp.chatBefore'), ...before.map((r) => this.chatLine(r, botId, t))]
          : []),
        '',
        t('whatsapp.chatNew'),
        ...batch.map((r) => this.chatLine(r, botId, t)),
      ].join('\n');
    const handed = await this.services.routines.runFromWhatsApp(
      { jid: chat, kind: row.kind, name: row.name || chat, threads: row.threads },
      `${chat}:${batch[0]!.seq}-${last}`,
      payloadFor,
    );
    if (!handed.done) {
      // A routine was too busy to take it: the same batch is offered again in a while.
      await this.moveOn(chat, row.batchedSeq, handed.threads, last);
      this.waitForQuiet(chat, this.chatQuietMs);
      return;
    }
    await this.moveOn(chat, last, handed.threads, null);
    if (more) this.waitForQuiet(chat, 0);
  }

  /** Moves a chat's place in the store on to `seq`, and keeps where a batch to offer again ends. */
  private async moveOn(chat: string, seq: number, threads: Record<string, string>, held: number | null) {
    await this.ctx.db
      .update(schema.whatsappChats)
      .set({
        batchedSeq: sql`greatest(${schema.whatsappChats.batchedSeq}, ${seq})`,
        heldSeq: held,
        ...(Object.keys(threads).length && {
          threads: sql`${schema.whatsappChats.threads} || ${JSON.stringify(threads)}::jsonb`,
        }),
      })
      .where(eq(schema.whatsappChats.jid, chat));
  }

  /** Chats with messages not yet handed over, from before a restart: their batches go out again. */
  private async resumeChats() {
    const rows = await this.ctx.db
      .select({ jid: schema.whatsappChats.jid })
      .from(schema.whatsappChats)
      .where(
        exists(
          this.ctx.db
            .select({ seq: schema.whatsappMessages.seq })
            .from(schema.whatsappMessages)
            .where(
              and(
                eq(schema.whatsappMessages.chat, schema.whatsappChats.jid),
                gt(schema.whatsappMessages.seq, schema.whatsappChats.batchedSeq),
                eq(schema.whatsappMessages.fromMe, false),
                eq(schema.whatsappMessages.hidden, false),
              ),
            ),
        ),
      );
    for (const r of rows) this.waitForQuiet(r.jid);
  }

  /**
   * Drops what is older than the time chats are kept, with its files in every bot's folder, and the
   * chats left with nothing.
   */
  async prune(now = new Date()) {
    const before = new Date(now.getTime() - CHAT_KEEP_MS);
    const old = await this.ctx.db
      .delete(schema.whatsappMessages)
      .where(lt(schema.whatsappMessages.at, before))
      .returning({ chat: schema.whatsappMessages.chat, file: schema.whatsappMessages.file });
    // A settled draft's text goes with them; one whose card is still open waits for its answer.
    await this.ctx.db
      .delete(schema.whatsappDrafts)
      .where(and(ne(schema.whatsappDrafts.status, 'pending'), lt(schema.whatsappDrafts.createdAt, before)));
    const bots = await readdir(resolve(this.ctx.config.dataDir, 'workspaces', 'bots')).catch(() => []);
    for (const r of old) {
      if (!r.file || !('name' in r.file)) continue;
      for (const botId of bots) await rm(join(this.chatFolder(botId, r.chat), r.file.name), { force: true });
    }
    await this.ctx.db
      .delete(schema.whatsappChats)
      .where(
        and(
          lt(schema.whatsappChats.lastAt, before),
          notExists(
            this.ctx.db
              .select({ seq: schema.whatsappMessages.seq })
              .from(schema.whatsappMessages)
              .where(eq(schema.whatsappMessages.chat, schema.whatsappChats.jid)),
          ),
        ),
      );
  }

  // For the bots' tools

  /** The chats kept here that `reads` covers, newest first, with their last message's time. */
  async chats(limit: number, reads: ChatReads) {
    const groups = [...reads.groups];
    const covered = or(
      reads.people ? eq(schema.whatsappChats.kind, 'person') : undefined,
      groups.length ? inArray(schema.whatsappChats.jid, groups) : undefined,
    );
    if (!covered) return [];
    return this.ctx.db
      .select({
        jid: schema.whatsappChats.jid,
        kind: schema.whatsappChats.kind,
        name: schema.whatsappChats.name,
        lastAt: schema.whatsappChats.lastAt,
      })
      .from(schema.whatsappChats)
      .where(covered)
      .orderBy(desc(schema.whatsappChats.lastAt))
      .limit(limit);
  }

  /** A chat's last messages as `botId` reads them; null when it is not kept here or not the bot's. */
  async history(chat: string, limit: number, botId: string, reads: ChatReads): Promise<string | null> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.whatsappChats)
      .where(eq(schema.whatsappChats.jid, chat))
      .limit(1);
    if (!row || !covers(reads, row)) return null;
    const rows = (
      await this.ctx.db
        .select()
        .from(schema.whatsappMessages)
        .where(eq(schema.whatsappMessages.chat, chat))
        .orderBy(desc(schema.whatsappMessages.seq))
        .limit(limit)
    ).reverse();
    const t = await this.services.settings.translator();
    const title = row.name || chat;
    return [
      t(row.kind === 'group' ? 'whatsapp.groupHeader' : 'whatsapp.chatHeader', { name: title }),
      t('whatsapp.chatId', { chat }),
      '',
      ...rows.map((r) => this.chatLine(r, botId, t)),
    ].join('\n');
  }

  /** Whether a chat is kept here, and `reads` covers it when given: only those can be answered. */
  async knownChat(
    chat: string,
    reads?: ChatReads,
  ): Promise<{ name: string; kind: 'person' | 'group' } | null> {
    const [row] = await this.ctx.db
      .select({
        jid: schema.whatsappChats.jid,
        name: schema.whatsappChats.name,
        kind: schema.whatsappChats.kind,
      })
      .from(schema.whatsappChats)
      .where(eq(schema.whatsappChats.jid, chat))
      .limit(1);
    if (!row || (reads && !covers(reads, row))) return null;
    return { name: row.name, kind: row.kind };
  }

  /** Who sees a Status post: the people whose chats are kept here. */
  async statusAudience(): Promise<string[]> {
    const rows = await this.ctx.db
      .select({ jid: schema.whatsappChats.jid })
      .from(schema.whatsappChats)
      .where(eq(schema.whatsappChats.kind, 'person'));
    return rows.map((r) => r.jid).filter((j) => j.endsWith('@s.whatsapp.net'));
  }

  /**
   * Sends the drafts whose cards were answered "send", and lets go of the ones turned down. Run on
   * every card answer and at each connect; a draft is claimed before it is sent, so it goes once.
   */
  private async settleDrafts() {
    if (this.stopped) return;
    const rows = await this.ctx.db
      .select({
        draft: schema.whatsappDrafts,
        status: schema.approvals.status,
        answer: schema.approvals.answer,
      })
      .from(schema.whatsappDrafts)
      .innerJoin(schema.approvals, eq(schema.approvals.id, schema.whatsappDrafts.approvalId))
      .where(and(eq(schema.whatsappDrafts.status, 'pending'), ne(schema.approvals.status, 'pending')));
    for (const { draft, status, answer } of rows) {
      const send = status === 'allowed' && answer === draft.approve;
      if (!send) {
        const [dropped] = await this.ctx.db
          .update(schema.whatsappDrafts)
          .set({ status: 'dropped' })
          .where(and(eq(schema.whatsappDrafts.id, draft.id), eq(schema.whatsappDrafts.status, 'pending')))
          .returning();
        if (dropped) {
          const t = await this.services.settings.translator();
          await this.draftNote(
            draft,
            t(draft.kind === 'status' ? 'whatsapp.statusDropped' : 'whatsapp.draftDropped'),
          );
        }
        continue;
      }
      // Sent only while connected; otherwise it waits for the next connect.
      if (this.state !== 'connected') continue;
      const [claimed] = await this.ctx.db
        .update(schema.whatsappDrafts)
        .set({ status: 'sent' })
        .where(and(eq(schema.whatsappDrafts.id, draft.id), eq(schema.whatsappDrafts.status, 'pending')))
        .returning();
      if (!claimed) continue;
      const t = await this.services.settings.translator();
      try {
        if (draft.kind === 'status') await this.postStatus(draft);
        else await this.sendDraft(draft, t);
      } catch (err) {
        console.warn('whatsapp draft', errorText(err));
        await this.ctx.db
          .update(schema.whatsappDrafts)
          .set({ status: 'failed' })
          .where(eq(schema.whatsappDrafts.id, draft.id));
        await this.draftNote(draft, t('whatsapp.draftFailed', { message: errorText(err) }), true);
        continue;
      }
      // Sent: whatever goes wrong after this does not make it look unsent, which would get it sent twice.
      await this.draftNote(
        draft,
        t(draft.kind === 'status' ? 'whatsapp.statusPosted' : 'whatsapp.draftSent'),
      ).catch((err: unknown) => console.warn('whatsapp draft note', errorText(err)));
    }
  }

  /** Says in the conversation the draft was made in what became of it. */
  private async draftNote(draft: typeof schema.whatsappDrafts.$inferSelect, text: string, failed = false) {
    await this.services.threads.addMessage({
      threadId: draft.threadId,
      role: failed ? 'error' : 'assistant',
      author: `bot:${draft.botId}`,
      text,
      props: { whatsappDraft: draft.id },
    });
  }

  /** What a draft's file is sent as, or nothing when it has none or it is gone. */
  private async draftFile(draft: typeof schema.whatsappDrafts.$inferSelect) {
    if (!draft.file) return null;
    const size = (await stat(draft.file)).size;
    if (size > SEND_MAX) throw new Error('file too large');
    const name = draft.file.split('/').pop() ?? 'file';
    const mime = mimeOf(name);
    return mime.startsWith('image/')
      ? { image: { url: draft.file }, mimetype: mime }
      : { document: { url: draft.file }, fileName: name, mimetype: mime };
  }

  /** Sends an approved reply into the chat it answers, and keeps it there as the person's own line. */
  private async sendDraft(draft: typeof schema.whatsappDrafts.$inferSelect, t: T) {
    const chat = draft.chat!;
    const socket = this.socket;
    const known = await this.knownChat(chat);
    if (!socket || !known) throw new Error('chat not found');
    // Groups are only read, whatever a draft says.
    if (known.kind !== 'person') throw new Error('WhatsApp groups are never written to');
    const file = await this.draftFile(draft);
    const content = file ? { ...file, ...(draft.text && { caption: draft.text }) } : { text: draft.text };
    const messageId = waMessageId();
    this.sentIds.add(messageId);
    const sent = await socket.sendMessage(chat, content, { messageId });
    const id = sent?.key?.id ?? messageId;
    if (sent?.message) this.sentBodies.set(id, { message: sent.message, at: Date.now() });
    await this.ctx.db
      .insert(schema.whatsappMessages)
      .values({
        chat,
        externalId: id,
        fromMe: true,
        writer: t('whatsapp.groupYou'),
        text: draft.text,
        at: new Date(),
        ...(draft.file && { file: { failed: 'whatsapp.draftFileSent' } }),
      })
      .onConflictDoNothing()
      .catch((err: unknown) => console.warn('whatsapp sent line', errorText(err)));
  }

  /** Posts an approved Status to the people whose chats are kept here. */
  private async postStatus(draft: typeof schema.whatsappDrafts.$inferSelect) {
    const socket = this.socket;
    if (!socket) throw new Error('WhatsApp is not connected');
    const audience = await this.statusAudience();
    if (!audience.length) throw new Error('nobody to show it to');
    const file = await this.draftFile(draft);
    const content = file ? { ...file, ...(draft.text && { caption: draft.text }) } : { text: draft.text };
    const messageId = waMessageId();
    this.sentIds.add(messageId);
    await socket.sendMessage(STATUS_JID, content, { messageId, statusJidList: audience, broadcast: true });
  }

  /**
   * Whether the self chat is being flooded, which happens when another bot answers on the same
   * number: requests pause for a while and the person is told. A request that comes during the pause
   * is not passed on, but the person hears so (at most once a minute) and when to write again;
   * commands and card answers still work, so they can stop what is going on.
   */
  private async looping(jid: string, t: T): Promise<boolean> {
    const now = Date.now();
    if (now < this.pausedUntil) {
      if (now - this.heldNoteAt >= 60_000) {
        this.heldNoteAt = now;
        const minutes = Math.max(1, Math.ceil((this.pausedUntil - now) / 60_000));
        await this.say(jid, t('channel.loopHeld', { minutes })).catch(() => {});
      }
      return true;
    }
    this.requestTimes.push(now);
    const longest = Math.max(...LOOP_LIMITS.map((l) => l.ms));
    this.requestTimes = this.requestTimes.filter((at) => now - at <= longest);
    const flood = LOOP_LIMITS.some(
      (l) => this.requestTimes.filter((at) => now - at <= l.ms).length > l.count,
    );
    if (!flood) return false;
    this.pausedUntil = now + LOOP_PAUSE_MS;
    this.requestTimes = [];
    this.heldNoteAt = now;
    await this.say(jid, t('channel.loopPaused')).catch(() => {});
    return true;
  }

  private async handle(socket: WaSocket, row: Row, jid: string, m: WaMessage, stamp: number) {
    const t = await this.services.settings.translator();
    const { text: raw, media, forwarded, quoted } = contentOf(m);
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
    // The conversation of the person who set the chat up.
    const thread = await this.services.threads.main(bot.id, row.userId);
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
    // Only what would start the bot counts toward the flood guard; commands and card answers do not.
    if ((row.settings as Settings).mode === 'own' && (await this.looping(jid, t))) return;
    const files: string[] = [];
    const failed: string[] = [];
    const tooLarge: string[] = [];
    const fetchFile = async (target: WaMessage, name: string, size: number | undefined, log: string) => {
      if ((size ?? 0) > RECEIVE_MAX) {
        tooLarge.push(name);
        await this.say(jid, t('channel.fileTooLarge', { name }));
        return;
      }
      try {
        const body = await this.lib!.download(target, socket);
        files.push((await saveUpload(stagingDir(this.ctx.config.dataDir, thread.id), name, body)).name);
      } catch (err) {
        console.warn(log, errorText(err));
        failed.push(name);
        await this.say(jid, t('channel.fileFailed', { name }));
      }
    };
    if (media) {
      const name = receivedName(media.kind, m.key.id ?? newId().slice(0, 8), media.mime, media.name);
      await fetchFile(m, name, media.size, 'whatsapp file');
    }
    // A reply to a message: one of ours is quoted by the app; another one's text and file come along.
    const replyTo = quoted?.id ? await this.ours(row.id, quoted.id) : null;
    let quote = '';
    if (quoted && !replyTo) {
      quote = quoted.text.trim();
      if (quoted.media) {
        const name = receivedName(
          quoted.media.kind,
          quoted.id ?? newId().slice(0, 8),
          quoted.media.mime,
          quoted.media.name,
        );
        await fetchFile(
          { key: { remoteJid: m.key.remoteJid, id: quoted.id }, message: quoted.message },
          name,
          quoted.media.size,
          'whatsapp quoted file',
        );
      }
    }
    if (!text && !files.length) return;
    // A quoted message not known here may be anyone's words (a forward, a message from before this
    // device): the message carries it as outside text, so it is never taken as the person's request.
    const outside = forwarded || quoted?.forwarded ? 'forward' : quoted && !replyTo ? 'stored' : null;
    const quoteBlock = quote
      ? `${quote
          .split('\n')
          .map((l) => `> ${l}`)
          .join('\n')}\n\n`
      : '';
    // Against the settings as they are now: a message handled alongside may have moved it on.
    await this.saveSettings(row, (now) => ({
      threadId: thread.id,
      seenAt: Math.max(now.seenAt ?? 0, stamp) || undefined,
    }));
    // Noted before the turn can start, so a restart in the middle leaves a trace to settle.
    await holdRequest(this.ctx, row.id, thread.id, { jid });
    this.working.add(thread.id);
    let message;
    try {
      ({ message } = await this.services.inbox.send(thread.id, {
        // Files that did not arrive are said to the bot too, or it would answer as if it had them.
        text: withMissingFiles(`${quoteBlock}${text}`, { failed, tooLarge }, t),
        files,
        clientId: `whatsapp:${(m.key.id ?? newId()).slice(0, 48)}`,
        userId: row.userId,
        ...(replyTo && { replyTo }),
        props: { via: 'whatsapp', ...(outside && { outside }) },
      }));
    } catch (err) {
      this.working.delete(thread.id);
      await dropRequest(this.ctx, row.id, thread.id);
      throw err;
    }
    // Nothing started (a repeated message, say): no turn will end it, so it ends here.
    if (this.working.has(thread.id) && (await this.services.threads.state(thread.id)) === 'idle') {
      this.working.delete(thread.id);
      await dropRequest(this.ctx, row.id, thread.id);
    }
    if (m.key.id) await this.remember(row.id, m.key.id, message.id);
  }

  /** Keeps which message here a WhatsApp message is, so a reply to it can be found. */
  private async remember(channelId: string, externalId: string, messageId: string) {
    await this.ctx.db
      .insert(schema.channelMessages)
      .values({ channelId, externalId, messageId })
      .onConflictDoNothing()
      .catch(() => {});
  }

  /** The message here that a WhatsApp message is, when it is one we know. */
  private async ours(channelId: string, externalId: string): Promise<string | null> {
    const [found] = await this.ctx.db
      .select({ messageId: schema.channelMessages.messageId })
      .from(schema.channelMessages)
      .where(
        and(
          eq(schema.channelMessages.channelId, channelId),
          eq(schema.channelMessages.externalId, externalId),
        ),
      )
      .limit(1);
    return found?.messageId ?? null;
  }

  private async pickBot(jid: string, row: Row, name: string | undefined, t: T) {
    // Only bots the person who set the chat up may talk with.
    const reached = new Set(
      await this.services.access.botIds(await this.services.access.viewerOf(row.userId), 'chat'),
    );
    const bots = (await this.services.bots.list()).filter((b) => !b.archivedAt && reached.has(b.id));
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

  /**
   * Where replies go: "Message yourself", or the person's own number. Not only while connected: a
   * reply written while the connection is down waits for it (see `online`).
   */
  private async chat(): Promise<{ row: Row; jid: string } | null> {
    const row = await this.row();
    if (!row || this.state === 'off' || this.state === 'error') return null;
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
      await this.deliver(async () => {
        // A report with nothing numbered in it leaves a number to the card sent before it.
        const answerable = this.cardLast !== null && this.cardLast === this.lastSent && !numbered(m.text);
        await this.markdown(jid, headed(), m.id);
        if (answerable) this.cardLast = this.lastSent;
      });
      return;
    }
    await this.deliver(async () => {
      if (m.role === 'approval') {
        const card = await this.services.approvals.get(String(m.props.approvalId)).catch(() => null);
        if (!card || card.status !== 'pending') return;
        const view = cardView(card, m.props, t, await this.services.settings.locale());
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
      if (m.text.trim()) {
        // A report with nothing numbered in it leaves a number to the card sent before it.
        const answerable =
          report && this.cardLast !== null && this.cardLast === this.lastSent && !numbered(m.text);
        await this.markdown(jid, report ? headed() : m.text, m.id);
        if (answerable) this.cardLast = this.lastSent;
      }
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
          const id = await this.send(jid, {
            document: { url: path },
            fileName: f.name,
            mimetype: mimeOf(f.name),
          });
          if (id) await this.mark(id, m.id);
        } catch (err) {
          console.warn('whatsapp send file', errorText(err));
          await this.markdown(jid, t('channel.fileInApp', { name: f.name }));
        }
      }
    });
  }

  /** Sends Markdown as WhatsApp text; with `messageId`, a reply to what was sent finds that message. */
  private async markdown(jid: string, md: string, messageId?: string) {
    for (const part of whatsappMessages(md)) {
      const id = await this.send(jid, { text: part });
      if (id && messageId) await this.mark(id, messageId);
    }
  }

  /** Keeps a message sent to WhatsApp as the message here it came from. */
  private async mark(externalId: string, messageId: string) {
    const row = await this.row();
    if (row) await this.remember(row.id, externalId, messageId);
  }

  /** A short line outside the order of replies (a command's answer). */
  private async say(jid: string, text: string) {
    await this.deliver(() => this.markdown(jid, text));
  }

  /**
   * Runs the sends of one reply in the chat's order. When some of it could not be delivered, the
   * person is told once that the rest is in the app, as soon as the connection allows.
   */
  private async deliver(job: () => Promise<void>) {
    const ok = await this.sends.run('wa', job);
    if (!ok && !this.stopped) this.undelivered = true;
    await this.tellUndelivered();
  }

  private async tellUndelivered() {
    if (!this.undelivered || this.stopped || this.state !== 'connected') return;
    const target = await this.chat();
    if (!target) return;
    this.undelivered = false;
    const t = await this.services.settings.translator();
    // Not through `deliver`: this note failing is only logged, it does not ask for another note.
    await this.sends.run('wa', () => this.markdown(target.jid, t('channel.notDelivered')));
  }

  /** What was sent lately, for WhatsApp's resend requests when the phone could not read a reply. */
  private sentMessage(id: string | null | undefined): Record<string, unknown> | undefined {
    const found = id ? this.sentBodies.get(id) : undefined;
    return found && Date.now() - found.at < SENT_KEEP_MS ? found.message : undefined;
  }

  private async send(jid: string, content: Record<string, unknown>): Promise<string | null> {
    // Groups are only read: whatever goes wrong elsewhere, nothing is written to one.
    if (!/@(s\.whatsapp\.net|lid)$/.test(jid)) throw new Error('WhatsApp only writes to a person');
    let socket = await this.online();
    if (!socket) throw new Error('WhatsApp is not connected');
    // One chat is posted to at a time (the send queue); this keeps its posts from coming in a burst.
    const wait = (this.lastPost.get(jid) ?? 0) + this.paceMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    // The id is chosen here and kept for a second try: should the first have gone through after
    // all, WhatsApp takes the second as the same message and the person sees it once.
    const messageId = waMessageId();
    // Known as ours before WhatsApp hands it back, which can happen before the send returns.
    this.sentIds.add(messageId);
    let sent;
    try {
      sent = await socket.sendMessage(jid, content, { messageId });
    } catch (err) {
      // The connection dropped under the send: once it is back, the send is tried again, once.
      if (this.socket === socket && this.state === 'connected') throw err;
      socket = await this.online();
      if (!socket) throw err;
      sent = await socket.sendMessage(jid, content, { messageId });
    }
    this.lastPost.set(jid, Date.now());
    const id = sent?.key?.id;
    this.lastSent = id ?? newId();
    if (id) {
      this.sentIds.add(id);
      // Only recent ones matter: WhatsApp hands a sent message back at once.
      if (this.sentIds.size > 500) this.sentIds.delete(this.sentIds.values().next().value!);
      if (sent?.message) {
        this.sentBodies.set(id, { message: sent.message, at: Date.now() });
        if (this.sentBodies.size > SENT_KEPT) this.sentBodies.delete(this.sentBodies.keys().next().value!);
      }
    }
    return id ?? null;
  }

  private async turnState(e: TurnEvent) {
    const target = await this.chat();
    const settings = (target?.row.settings ?? {}) as Settings;
    const active =
      !!target &&
      this.state === 'connected' &&
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
      if (e.state === 'idle') await this.finished(e.threadId);
      return;
    }
    if (timer || this.stopped) return;
    const send = () => void this.socket?.sendPresenceUpdate('composing', target.jid).catch(() => {});
    send();
    const next = setInterval(send, 8000);
    next.unref?.();
    this.typing.set(e.threadId, next);
  }

  /**
   * The bot is done with a request from WhatsApp: the note of it goes, and when it ended well but
   * said nothing, the person hears that instead of only seeing "typing…" stop.
   */
  private async finished(threadId: string) {
    if (!this.working.delete(threadId)) return;
    const row = await this.row();
    if (!row) return;
    await dropRequest(this.ctx, row.id, threadId);
    if (this.stopped) return;
    if (!(await saidNothing(this.ctx, threadId))) return;
    const target = await this.chat();
    if (!target) return;
    const t = await this.services.settings.translator();
    await this.deliver(() => this.markdown(target.jid, t('channel.noAnswer')));
  }

  private async notice(e: NoticeEvent) {
    if (this.stopped || e.kind === 'reply') return;
    const target = await this.chat();
    if (!target || target.row.botId !== e.botId) return;
    const settings = target.row.settings as Settings;
    if (settings.notices === false) return;
    // Only of the person's own conversations, or the bot's own work they may change.
    if (!(await this.services.access.noticeAudience(e.threadId)).includes(target.row.userId)) return;
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

  /** Changes some settings; `patch` may be worked out from the settings as they are when saved. */
  private async saveSettings(
    row: Row,
    patch: Record<string, unknown> | ((now: Settings) => Record<string, unknown>),
  ) {
    const latest = (await this.row()) ?? row;
    const changes = typeof patch === 'function' ? patch(latest.settings as Settings) : patch;
    await this.ctx.db
      .update(schema.channels)
      .set({ settings: { ...latest.settings, ...changes } })
      .where(eq(schema.channels.id, row.id));
  }

  /** A stored key; `ns` is the prefix of the device being used, or '' for keys of no device. */
  private async key(key: string, ns = this.ns): Promise<string | null> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.whatsappKeys)
      .where(eq(schema.whatsappKeys.key, `${ns}${key}`))
      .limit(1);
    if (!row) return null;
    try {
      return this.vault.open(row.value);
    } catch {
      return null;
    }
  }

  /** Runs a change of the keys after the ones asked before it, so the order they were asked in holds. */
  private ordered<T>(job: () => Promise<T>): Promise<T> {
    const run = this.writes.then(job);
    this.writes = run.catch(() => {});
    return run;
  }

  /** Writes keys in one transaction; `plain` keys belong to no device and ignore the link prefix. */
  private setKeys(values: Record<string, string | null>, plain = false): Promise<void> {
    return this.ordered(async () => {
      const ns = plain ? '' : this.ns;
      await this.ctx.db.transaction(async (tx) => {
        for (const [name, value] of Object.entries(values)) {
          const key = `${ns}${name}`;
          if (value === null) {
            await tx.delete(schema.whatsappKeys).where(eq(schema.whatsappKeys.key, key));
            continue;
          }
          const sealed = this.vault.seal(value);
          await tx
            .insert(schema.whatsappKeys)
            .values({ key, value: sealed })
            .onConflictDoUpdate({ target: schema.whatsappKeys.key, set: { value: sealed } });
        }
      });
    });
  }

  /** The keys of a device that is gone; keys of no device stay. */
  private wipeKeys(): Promise<void> {
    return this.ordered(async () => {
      await this.ctx.db.delete(schema.whatsappKeys).where(not(like(schema.whatsappKeys.key, `${META_NS}%`)));
    });
  }

  /** The keys of a link that did not finish. */
  private dropNs(): Promise<void> {
    return this.ordered(async () => {
      await this.ctx.db.delete(schema.whatsappKeys).where(like(schema.whatsappKeys.key, `${LINK_NS}%`));
    });
  }

  /**
   * The new device is saved: the device that was linked before goes, and the new keys take their
   * place, all at once, so there is never a moment with neither.
   */
  private async promote() {
    await this.flushCreds();
    await this.ordered(async () => {
      await this.ctx.db.transaction(async (tx) => {
        await tx
          .delete(schema.whatsappKeys)
          .where(
            and(
              not(like(schema.whatsappKeys.key, `${LINK_NS}%`)),
              not(like(schema.whatsappKeys.key, `${META_NS}%`)),
            ),
          );
        await tx
          .update(schema.whatsappKeys)
          .set({ key: sql`substr(${schema.whatsappKeys.key}, ${LINK_NS.length + 1})` })
          .where(like(schema.whatsappKeys.key, `${LINK_NS}%`));
      });
      this.ns = '';
    });
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

/** A name as one line: WhatsApp names and group subjects may hold line breaks. */
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 100);

/** The chats a bot's routines read: the groups they follow, and people's chats when one reads those. */
export interface ChatReads {
  groups: Set<string>;
  people: boolean;
}

function covers(reads: ChatReads, chat: { jid: string; kind: 'person' | 'group' }): boolean {
  return chat.kind === 'group' ? reads.groups.has(chat.jid) : reads.people;
}

/** About how long a stored message is as a bot reads it. */
function lineChars(r: { writer: string; text: string }): number {
  return r.writer.length + r.text.length + 40;
}

/**
 * The first messages of `rows` that fit in `chars`: always at least one unless `orNone`, so a
 * batch moves on even past a message longer than the rest.
 */
function withinChars<R extends { writer: string; text: string }>(
  rows: R[],
  chars: number,
  orNone = false,
): R[] {
  let used = 0;
  let n = 0;
  for (const r of rows) {
    used += lineChars(r);
    if (used > chars && (n > 0 || orNone)) break;
    n++;
  }
  return rows.slice(0, n);
}

/**
 * Whether a text holds a numbered line ("1. ...", "2) ..."): a number typed after it may mean one
 * of those, so it no longer answers the card sent before it.
 */
function numbered(text: string): boolean {
  return /^\s*\d{1,2}\s*[.)-]\s/m.test(text);
}

/** A message id in the form WhatsApp's own clients use. */
const waMessageId = () => `3EB0${randomBytes(18).toString('hex').toUpperCase()}`;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
