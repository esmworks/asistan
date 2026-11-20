import { EgressMux } from '@leafbot/shared/egress';
import WebSocket from 'ws';
import type { EgressHub } from './hub';

const RETRY_MS = 5_000;

/**
 * Keeps a connection to the computer service, whose desktops send their browser connections here
 * to leave through the person's computer. The service is told whether that way is open, so it
 * does not ask while it is not; when this connection is down it connects from itself.
 */
export function linkComputer(hub: EgressHub, opts: { url: string; token: string }): () => void {
  let ws: WebSocket | null = null;
  let mux: EgressMux | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const tell = () => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ route: hub.exit() === 'computer' }));
  };
  const off = hub.on(tell);

  const connect = () => {
    timer = null;
    if (stopped) return;
    const u = new URL(`${opts.url}/egress`);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.searchParams.set('token', opts.token);
    const socket = new WebSocket(u, { maxPayload: 1024 * 1024 });
    ws = socket;
    const m = new EgressMux({
      send: (f) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(f, { binary: true });
      },
      dial: (host, port) => hub.dial(host, port),
    });
    mux = m;
    socket.on('open', tell);
    socket.on('message', (data, binary) => {
      if (binary && Buffer.isBuffer(data)) m.receive(data);
    });
    const down = () => {
      m.close();
      if (ws === socket) {
        ws = null;
        mux = null;
      }
      if (stopped || timer) return;
      timer = setTimeout(connect, RETRY_MS);
      timer.unref();
    };
    socket.on('close', down);
    socket.on('error', () => socket.terminate());
  };
  connect();

  return () => {
    stopped = true;
    off();
    if (timer) clearTimeout(timer);
    mux?.close();
    ws?.terminate();
  };
}
