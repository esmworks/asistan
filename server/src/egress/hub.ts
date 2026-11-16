import { createServer, type Server } from 'node:net';
import type { Duplex } from 'node:stream';
import {
  dialPublic,
  EgressError,
  EgressMux,
  join,
  socksAccept,
  socksReply,
  socksReplyFor,
  SOCKS_REPLY,
} from '@yumakbot/shared/egress';

/** Where the bots' browser traffic leaves: the person's computer, or this server. */
export type Exit = 'computer' | 'server';

export interface EgressState {
  /** The person switched it on. */
  enabled: boolean;
  /** A computer of theirs is connected and carries the traffic. */
  connected: boolean;
  /** That computer's name, as it gave it. */
  device: string | null;
}

interface Link {
  device: string;
  mux: EgressMux;
  close(): void;
}

/**
 * The person's own computer as the way out for the bots' browsers, so sites see that computer's
 * connection instead of the server's. The desktop app connects and offers itself; while the
 * setting is on and it is connected, each new browser connection goes through it. Otherwise the
 * caller connects from the server as before: a connection is never refused for lack of the
 * computer.
 */
export class EgressHub {
  private enabled = false;
  private link: Link | null = null;
  /** The way out each bot was last told about. */
  private told = new Map<string, Exit>();
  private listeners = new Set<() => void>();

  on(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  setEnabled(on: boolean) {
    if (on === this.enabled) return;
    this.enabled = on;
    this.changed();
  }

  state(): EgressState {
    return { enabled: this.enabled, connected: !!this.link, device: this.link?.device ?? null };
  }

  /** Where new connections leave now; null while the setting is off. */
  exit(): Exit | null {
    if (!this.enabled) return null;
    return this.link ? 'computer' : 'server';
  }

  /**
   * A person's computer offers itself. The last one to connect is used; one connected before it
   * is let go. `send` puts a frame on its connection, `close` ends that connection.
   */
  attach(device: string, send: (frame: Buffer) => void, close: () => void) {
    const link: Link = { device: device.slice(0, 100), mux: new EgressMux({ send }), close };
    const before = this.link;
    this.link = link;
    if (before) {
      before.mux.close();
      before.close();
    }
    this.changed();
    return {
      receive: (frame: Buffer) => link.mux.receive(frame),
      detach: () => {
        link.mux.close();
        if (this.link !== link) return;
        this.link = null;
        this.changed();
      },
    };
  }

  /** A connection through the person's computer; `unavailable` while it is off or not there. */
  dial(host: string, port: number): Promise<Duplex> {
    if (!this.enabled || !this.link) return Promise.reject(new EgressError('unavailable'));
    return this.link.mux.open(host, port);
  }

  /**
   * The way out, if it changed since this bot last heard (or it never heard while the setting was
   * on), so the bot knows which connection the sites see.
   */
  takeExitNote(botId: string): Exit | null {
    const now = this.exit();
    if (!now) {
      this.told.delete(botId);
      return null;
    }
    if (this.told.get(botId) === now) return null;
    this.told.set(botId, now);
    return now;
  }

  close() {
    const link = this.link;
    this.link = null;
    link?.mux.close();
    link?.close();
  }

  private changed() {
    for (const l of this.listeners) l();
  }
}

/**
 * A SOCKS5 proxy on this server's loopback for its own bot browsers (when there is no computer
 * service). Each connection goes through the person's computer when it can, otherwise straight
 * from here, where private addresses are refused: this server sits on the network of its
 * database. `allowHosts` are the private hosts the operator lets the browsers reach.
 */
export async function startLocalSocks(
  hub: EgressHub,
  allowHosts: readonly string[],
): Promise<{ port: number; close(): void }> {
  const server: Server = createServer({ allowHalfOpen: true }, (client) => {
    client.on('error', () => {});
    void (async () => {
      let target: { host: string; port: number };
      try {
        target = await socksAccept(client);
      } catch {
        return;
      }
      let up: Duplex;
      try {
        up = await hub.dial(target.host, target.port).catch((err: unknown) => {
          if (err instanceof EgressError && err.code === 'unavailable') {
            return dialPublic(target.host, target.port, { allowHosts });
          }
          throw err;
        });
      } catch (err) {
        return socksReply(client, socksReplyFor(err));
      }
      if (client.destroyed) return void up.destroy();
      socksReply(client, SOCKS_REPLY.ok);
      join(client, up);
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no proxy port');
  return { port: address.port, close: () => server.close() };
}
