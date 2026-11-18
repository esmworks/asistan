import { DiscordError } from './discord-api';

/** The events the server asks for: servers, their messages, direct messages. */
const GUILDS = 1 << 0;
const GUILD_MESSAGES = 1 << 9;
const DIRECT_MESSAGES = 1 << 12;
/**
 * The text of every message, not only of those that mention the bot. Discord gives it only when
 * it is switched on for the bot in the developer portal; without it the bot still reads mentions.
 */
const MESSAGE_CONTENT = 1 << 15;

/** One dispatch from the Gateway: its event name and data. */
export interface GatewayEvent {
  t: string;
  d: Record<string, unknown>;
}

/** What the connection reports: working, or why not, and whether message text comes at all. */
export interface GatewayState {
  error: string | null;
  messageContent: boolean;
  /** The bot's user, once Discord said who it is. */
  user?: { id: string; name: string };
}

interface Frame {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

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

/**
 * How often a connection checks the clock, and the gap that says the computer slept meanwhile. A
 * connection from before a sleep is usually dead without anyone saying so; it is dropped and
 * resumed.
 */
const TICK_MS = 30_000;
const SLEPT_MS = 90_000;

/** Closes after which connecting again cannot help: a wrong token, a wrong setup of the bot. */
const FINAL: Record<number, string> = {
  4004: 'authentication_failed',
  4010: 'invalid_shard',
  4011: 'sharding_required',
  4012: 'invalid_api_version',
  4013: 'invalid_intents',
};
/** Closes after which the session is gone and a fresh one starts. */
const FRESH = new Set([4007, 4009]);
/** Discord refused the Message Content intent: the bot is not allowed it in the developer portal. */
const DISALLOWED_INTENTS = 4014;
/** Our own close that keeps the session for a resume (1000 and 1001 end it). */
const KEEP = 4000;

/**
 * Discord's Gateway: a WebSocket the server keeps open to Discord, down which messages and button
 * presses come, so no public address is needed. It keeps the heartbeat Discord asks for, resumes
 * after a drop so nothing sent meanwhile is lost, and starts afresh when Discord says the session
 * is gone.
 */
export class DiscordGateway {
  private stop = new AbortController();
  private socket: WebSocket | null = null;
  private session: { id: string; url: string } | null = null;
  private seq: number | null = null;
  private intents = GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT;
  readonly done: Promise<void>;

  constructor(
    private token: string,
    /** A fresh address to connect at (`GET /gateway/bot`). */
    open: (signal: AbortSignal) => Promise<string>,
    private handle: (e: GatewayEvent) => Promise<void>,
    private state: (s: GatewayState) => void,
  ) {
    this.done = this.run(open).catch((err: unknown) => console.warn('discord gateway', err));
  }

  close() {
    this.stop.abort();
    this.socket?.close(1000);
  }

  private get messageContent() {
    return (this.intents & MESSAGE_CONTENT) !== 0;
  }

  private async run(open: (signal: AbortSignal) => Promise<string>) {
    const signal = this.stop.signal;
    let wait = 1000;
    while (!signal.aborted) {
      let url = this.session?.url;
      if (!url) {
        try {
          url = await open(signal);
        } catch (err) {
          if (signal.aborted) return;
          this.state({
            error: err instanceof DiscordError ? err.code : (err as Error).message,
            messageContent: this.messageContent,
          });
          if (err instanceof DiscordError && err.status === 401) return;
          if (err instanceof DiscordError && err.retryAfter) wait = Math.max(wait, err.retryAfter * 1000);
          await sleep(wait, signal);
          wait = Math.min(wait * 2, 60_000);
          continue;
        }
      }
      const end = await this.connect(url, signal);
      if (end.final) {
        this.state({ error: end.final, messageContent: this.messageContent });
        return;
      }
      if (end.ready) wait = 1000;
      else {
        await sleep(wait, signal);
        wait = Math.min(wait * 2, 60_000);
      }
    }
  }

  /** One connection, until it closes: whether Discord said ready (or resumed) on it, or why to stop. */
  private connect(url: string, signal: AbortSignal): Promise<{ ready: boolean; final?: string }> {
    return new Promise((resolve) => {
      const address = new URL(url);
      address.searchParams.set('v', '10');
      address.searchParams.set('encoding', 'json');
      const ws = new WebSocket(address);
      this.socket = ws;
      let ready = false;
      let beat: ReturnType<typeof setInterval> | undefined;
      let first: ReturnType<typeof setTimeout> | undefined;
      let acked = true;
      let last = Date.now();
      const send = (f: Frame) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(f));
      };
      const heartbeat = () => {
        // No answer to the last beat: the connection is dead though open. It is left to resume.
        if (!acked) {
          ws.close(KEEP);
          return;
        }
        acked = false;
        send({ op: 1, d: this.seq });
      };
      const watch = setInterval(() => {
        const now = Date.now();
        const slept = now - last > SLEPT_MS;
        last = now;
        if (!slept) return;
        // A dead connection may never finish closing, so this one is left for a new one at once.
        ws.close(KEEP);
        finish({ ready });
      }, TICK_MS);
      watch.unref?.();
      let finished = false;
      const finish = (r: { ready: boolean; final?: string }) => {
        if (finished) return;
        finished = true;
        clearInterval(watch);
        clearInterval(beat);
        clearTimeout(first);
        if (this.socket === ws) this.socket = null;
        resolve(r);
      };
      ws.addEventListener('close', (ev) => {
        const code = (ev as CloseEvent).code;
        if (FINAL[code]) return finish({ ready, final: FINAL[code] });
        if (code === DISALLOWED_INTENTS && this.messageContent) {
          // Not allowed the text of every message: the bot connects without it and reads mentions.
          this.intents &= ~MESSAGE_CONTENT;
          this.session = null;
          return finish({ ready: true });
        }
        if (code === DISALLOWED_INTENTS) return finish({ ready, final: 'disallowed_intents' });
        if (FRESH.has(code)) {
          this.session = null;
          this.seq = null;
        }
        finish({ ready });
      });
      ws.addEventListener('error', () => ws.close(KEEP));
      signal.addEventListener('abort', () => ws.close(1000), { once: true });
      ws.addEventListener('message', (msg) => {
        if (this.socket !== ws) return;
        let f: Frame;
        try {
          f = JSON.parse(String(msg.data)) as Frame;
        } catch {
          return;
        }
        if (typeof f.s === 'number') this.seq = f.s;
        switch (f.op) {
          case 10: {
            const interval =
              Number((f.d as { heartbeat_interval?: number } | undefined)?.heartbeat_interval) || 41_250;
            // The first beat at a random point of the interval, as Discord asks, so many bots
            // starting together do not beat together.
            first = setTimeout(
              () => {
                heartbeat();
                beat = setInterval(heartbeat, interval);
                beat.unref?.();
              },
              Math.floor(interval * Math.random()),
            );
            first.unref?.();
            if (this.session && this.seq !== null) {
              send({ op: 6, d: { token: this.token, session_id: this.session.id, seq: this.seq } });
            } else {
              send({
                op: 2,
                d: {
                  token: this.token,
                  intents: this.intents,
                  properties: { os: process.platform, browser: 'yumakbot', device: 'yumakbot' },
                },
              });
            }
            return;
          }
          case 11:
            acked = true;
            return;
          case 1:
            send({ op: 1, d: this.seq });
            return;
          case 7:
            // Discord asks for a new connection; the session goes on there.
            ws.close(KEEP);
            return;
          case 9:
            // The session cannot go on: a fresh one, after the wait Discord asks for.
            if (!f.d) {
              this.session = null;
              this.seq = null;
            }
            setTimeout(() => ws.close(KEEP), 1000 + Math.floor(Math.random() * 4000)).unref?.();
            return;
          case 0:
            break;
          default:
            return;
        }
        const t = f.t ?? '';
        const d = (f.d ?? {}) as Record<string, unknown>;
        if (t === 'READY') {
          const resumeUrl = typeof d.resume_gateway_url === 'string' ? d.resume_gateway_url : url;
          this.session = { id: String(d.session_id ?? ''), url: resumeUrl };
          const user = d.user as { id?: string; username?: string; global_name?: string | null } | undefined;
          ready = true;
          this.state({
            error: null,
            messageContent: this.messageContent,
            ...(user?.id && { user: { id: user.id, name: user.global_name || user.username || user.id } }),
          });
        } else if (t === 'RESUMED') {
          ready = true;
          this.state({ error: null, messageContent: this.messageContent });
        }
        void this.handle({ t, d }).catch((err: unknown) => console.warn('discord event', err));
      });
    });
  }
}
