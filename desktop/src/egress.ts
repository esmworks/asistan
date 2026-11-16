import { dialPublic, EgressMux, WEB_PORTS } from '@yumakbot/shared/egress';
import { io, type Socket } from 'socket.io-client';

export interface EgressOptions {
  /** The server's address. */
  url: string;
  /** The sign-in for the connection: the access key, or the window's session cookie. */
  headers(): Promise<Record<string, string>>;
  /** How this computer is named in the server's settings. */
  device: string;
  log(level: 'info' | 'warn', message: string): void;
}

/**
 * Offers this computer as the way out to the web for the bots' browsers on a remote server, so
 * sites see this computer's connection. The server uses it only while its setting is on.
 *
 * Only web ports and public addresses are reached; the names are looked up here and the
 * connection goes to the address found. This computer's own services and its home or office
 * network stay out of reach of the server.
 */
export function startEgress(o: EgressOptions): () => void {
  let mux: EgressMux | null = null;
  let stopped = false;
  const socket: Socket = io(`${o.url}/egress`, {
    path: '/socket.io',
    transports: ['websocket'],
    auth: { device: o.device },
    autoConnect: false,
    reconnectionDelay: 2_000,
    reconnectionDelayMax: 60_000,
  });
  const signIn = async () => {
    socket.io.opts.extraHeaders = await o.headers().catch(() => ({}));
  };

  socket.on('connect', () => {
    mux?.close();
    mux = new EgressMux({
      send: (f) => {
        if (socket.connected) socket.emit('f', f);
      },
      dial: (host, port) => dialPublic(host, port, { ports: WEB_PORTS }),
    });
    o.log('info', 'egress: connected');
  });
  socket.on('f', (f: unknown) => {
    if (Buffer.isBuffer(f)) mux?.receive(f);
  });
  socket.on('disconnect', (reason) => {
    mux?.close();
    mux = null;
    // A server that let this computer go (another one took over) is not asked again until the app
    // connects anew; two computers would otherwise take it from each other in turns.
    o.log('info', `egress: disconnected (${reason})`);
  });
  // A sign-in that changed (a new session cookie) is picked up for the next try.
  socket.on('connect_error', (err) => {
    o.log('warn', `egress: ${err.message}`);
    void signIn();
  });
  const reconnect = async () => {
    if (stopped || socket.connected) return;
    await signIn();
    socket.connect();
  };
  void reconnect();

  return () => {
    stopped = true;
    mux?.close();
    mux = null;
    socket.disconnect();
  };
}
