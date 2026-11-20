import { createServer, type Server, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import {
  dialPublic,
  join,
  socksAccept,
  socksReply,
  socksReplyFor,
  SOCKS_REPLY,
  type DialOptions,
} from '@leafbot/shared/egress';

/** The most a client may send before its request line and headers end. */
const MAX_HEAD = 64 * 1024;
const HEAD_TIMEOUT_MS = 15_000;

export interface SandboxProxy {
  httpPort: number;
  socksPort: number;
  close(): void;
}

export interface SandboxProxyOptions {
  /** A command reached this host: what comes back is text from outside. */
  onReach?: (host: string) => void;
  /** Tests pass stand-ins for the name lookup and the connection. */
  dial?: DialOptions;
}

/**
 * The way out for a bot's sandboxed shell commands, in place of the proxy Claude Code runs. That
 * one is told which host names may be reached and looks each name up again when it connects, so
 * a name that answered with a public address when it was let through could answer with this
 * machine's, the cloud's metadata service's or the private network's a moment later. Here every
 * connection looks the name up once and goes to the address found, and only when that address is
 * on the public internet (see `dialPublic`).
 */
export async function startSandboxProxy(o: SandboxProxyOptions = {}): Promise<SandboxProxy> {
  const dial = (host: string, port: number) => dialPublic(host, port, o.dial);
  const reached = (host: string) => {
    try {
      o.onReach?.(host);
    } catch {
      // Being told is a courtesy; the connection goes on either way.
    }
  };
  const socks = createServer({ allowHalfOpen: true }, (client) => {
    client.on('error', () => {});
    void (async () => {
      let target: { host: string; port: number };
      try {
        target = await socksAccept(client);
      } catch {
        return;
      }
      let up: Socket;
      try {
        up = await dial(target.host, target.port);
      } catch (err) {
        return socksReply(client, socksReplyFor(err));
      }
      if (client.destroyed) return void up.destroy();
      reached(target.host);
      socksReply(client, SOCKS_REPLY.ok);
      join(client, up);
    })();
  });
  const http = createServer({ allowHalfOpen: true }, (client) => {
    client.on('error', () => {});
    void serveHttp(client, dial, reached);
  });
  const [socksPort, httpPort] = await Promise.all([listen(socks), listen(http)]);
  return {
    socksPort,
    httpPort,
    close: () => {
      socks.close();
      http.close();
    },
  };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('no proxy port'));
      else resolve(address.port);
    });
  });
}

/** The request line and headers, and what came after them. */
function readHead(client: Socket): Promise<{ head: string; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const finish = () => {
      clearTimeout(timer);
      client.pause();
      client.off('data', onData);
      client.off('close', onClose);
    };
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end >= 0) {
        finish();
        resolve({ head: buf.subarray(0, end).toString('latin1'), rest: buf.subarray(end + 4) });
      } else if (buf.length > MAX_HEAD) {
        finish();
        reject(new Error('head too long'));
      }
    };
    const onClose = () => {
      finish();
      reject(new Error('closed'));
    };
    const timer = setTimeout(() => {
      finish();
      reject(new Error('timed out'));
    }, HEAD_TIMEOUT_MS);
    client.on('data', onData);
    client.on('close', onClose);
  });
}

const refuse = (client: Socket, status: string) =>
  client.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);

/**
 * One request of a client: `CONNECT host:port` becomes a tunnel; a plain `GET http://…` is sent
 * on to its host, alone on its connection, so a second request on it cannot go to another host.
 */
async function serveHttp(
  client: Socket,
  dial: (host: string, port: number) => Promise<Socket>,
  reached: (host: string) => void,
) {
  let head: string;
  let rest: Buffer;
  try {
    ({ head, rest } = await readHead(client));
  } catch {
    client.destroy();
    return;
  }
  const [line = '', ...headers] = head.split('\r\n');
  const [method = '', target = '', version = 'HTTP/1.1'] = line.split(' ');
  let host: string;
  let port: number;
  let path = '';
  if (method.toUpperCase() === 'CONNECT') {
    const m = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(target);
    if (!m) return refuse(client, '400 Bad Request');
    host = m[1]!;
    port = Number(m[2]);
  } else {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      return refuse(client, '400 Bad Request');
    }
    if (url.protocol !== 'http:') return refuse(client, '400 Bad Request');
    host = url.hostname.replace(/^\[|\]$/g, '');
    port = Number(url.port || 80);
    path = `${url.pathname}${url.search}`;
  }
  let up: Duplex;
  try {
    up = await dial(host, port);
  } catch {
    return refuse(client, '403 Forbidden');
  }
  if (client.destroyed) return void up.destroy();
  reached(host);
  if (method.toUpperCase() === 'CONNECT') {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (rest.length) up.write(rest);
  } else {
    const kept = headers.filter((h) => !/^(?:proxy-[\w-]*|connection|keep-alive)\s*:/i.test(h));
    up.write(`${method} ${path || '/'} ${version}\r\n${[...kept, 'Connection: close'].join('\r\n')}\r\n\r\n`);
    if (rest.length) up.write(rest);
  }
  join(client, up);
}
