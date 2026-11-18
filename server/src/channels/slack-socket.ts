import { SlackError } from './slack-api';

/** What Slack sends over a Socket Mode connection. */
export interface SlackEnvelope {
  type: string;
  envelope_id?: string;
  payload?: Record<string, unknown>;
  /** `disconnect`: why Slack closes the connection (a refresh, a warning, Socket Mode turned off). */
  reason?: string;
  retry_attempt?: number;
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
 * connection from before a sleep is usually dead without anyone saying so, and nothing would arrive
 * on it; it is dropped and a new one opened.
 */
const TICK_MS = 30_000;
const SLEPT_MS = 90_000;

/** Refusals that asking again does not change: a wrong or revoked token, Socket Mode turned off. */
const FINAL = new Set([
  'invalid_auth',
  'not_authed',
  'account_inactive',
  'token_revoked',
  'not_allowed_token_type',
  'missing_scope',
]);

/**
 * Slack's Socket Mode: the server opens a WebSocket to Slack and Slack sends events and button
 * presses down it, so no public address is needed. Each envelope is acknowledged as soon as it
 * arrives (Slack sends it again otherwise) and then handled. Slack closes the connection every few
 * hours; a new one is opened each time.
 */
export class SlackSocket {
  private stop = new AbortController();
  private socket: WebSocket | null = null;
  readonly done: Promise<void>;

  constructor(
    /** A fresh connection address (`apps.connections.open`). */
    open: (signal: AbortSignal) => Promise<string>,
    handle: (e: SlackEnvelope) => Promise<void>,
    /** The connection works (null) or why it does not, in Slack's words. */
    state: (error: string | null) => void,
  ) {
    this.done = this.run(open, handle, state).catch((err: unknown) => console.warn('slack socket', err));
  }

  close() {
    this.stop.abort();
    this.socket?.close();
  }

  private async run(
    open: (signal: AbortSignal) => Promise<string>,
    handle: (e: SlackEnvelope) => Promise<void>,
    state: (error: string | null) => void,
  ) {
    const signal = this.stop.signal;
    let wait = 1000;
    while (!signal.aborted) {
      let url: string;
      try {
        url = await open(signal);
      } catch (err) {
        if (signal.aborted) return;
        const code = err instanceof SlackError ? err.code : (err as Error).message;
        state(code);
        if (err instanceof SlackError && FINAL.has(err.code)) return;
        if (err instanceof SlackError && err.retryAfter) wait = Math.max(wait, err.retryAfter * 1000);
        await sleep(wait, signal);
        wait = Math.min(wait * 2, 60_000);
        continue;
      }
      const opened = await this.connect(url, handle, state, signal);
      if (opened) wait = 1000;
      else {
        await sleep(wait, signal);
        wait = Math.min(wait * 2, 60_000);
      }
    }
  }

  /** One connection, until it closes; whether Slack said hello on it. */
  private connect(
    url: string,
    handle: (e: SlackEnvelope) => Promise<void>,
    state: (error: string | null) => void,
    signal: AbortSignal,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      let hello = false;
      const ws = new WebSocket(url);
      this.socket = ws;
      let last = Date.now();
      const watch = setInterval(() => {
        const now = Date.now();
        const slept = now - last > SLEPT_MS;
        last = now;
        if (!slept) return;
        // A dead connection may never finish closing, so this one is left for a new one at once.
        ws.close();
        end();
      }, TICK_MS);
      watch.unref?.();
      const end = () => {
        clearInterval(watch);
        if (this.socket === ws) this.socket = null;
        resolve(hello);
      };
      ws.addEventListener('close', end);
      ws.addEventListener('error', () => ws.close());
      signal.addEventListener('abort', () => ws.close(), { once: true });
      ws.addEventListener('message', (ev) => {
        // Left for a newer one: Slack sends again what was not acknowledged.
        if (this.socket !== ws) return;
        let e: SlackEnvelope;
        try {
          e = JSON.parse(String(ev.data)) as SlackEnvelope;
        } catch {
          return;
        }
        if (e.type === 'hello') {
          hello = true;
          state(null);
          return;
        }
        if (e.type === 'disconnect') {
          ws.close();
          return;
        }
        if (e.envelope_id) ws.send(JSON.stringify({ envelope_id: e.envelope_id }));
        void handle(e).catch((err: unknown) => console.warn('slack event', err));
      });
    });
  }
}
