import { lookup as dnsLookup } from 'node:dns/promises';
import { connect as netConnect, isIP, type Socket } from 'node:net';
import { Duplex } from 'node:stream';

/**
 * The bots' browser can reach the web through the person's own computer, so sites see that
 * computer's connection instead of the server's. Connections travel as numbered streams over one
 * message channel (a WebSocket, a socket.io connection) and leave from the far end, the exit.
 *
 * A frame is one binary message: a type byte, a 32-bit stream number and the payload.
 */

/** Asks the exit to connect; payload `{"host","port"}` as JSON. Only the entry side sends it. */
const OPEN = 1;
/** The exit connected; data may flow. */
const OPENED = 2;
/** Bytes of the stream. */
const DATA = 3;
/** The sender will write no more; it still reads. */
const END = 4;
/** The stream is over in both directions, cleanly or not. */
const RESET = 5;
/** The open failed; payload is an EgressCode. */
const ERROR = 6;
/** The receiver used this many more bytes (32-bit payload): the sender may send that many again. */
const ACK = 7;

const HEADER = 5;
/** Large writes are cut so one stream does not hold the channel for long. */
const MAX_CHUNK = 64 * 1024;
/**
 * The most a stream sends before the other end says it used them. A slow link (a home
 * connection's upload) then holds back the connection it reads from instead of filling memory
 * with frames waiting to go out.
 */
const WINDOW = 256 * 1024;
/** Used bytes are reported once this many add up, or at once when the reader caught up. */
const ACK_STEP = 32 * 1024;
const OPEN_TIMEOUT_MS = 30_000;
const MAX_STREAMS = 512;

/**
 * Why a connection could not be made: `refused` by the exit's rules (a private address, a port it
 * does not serve), `unavailable` because no exit is there, `failed` to connect, or `timeout`.
 */
export type EgressCode = 'refused' | 'unavailable' | 'failed' | 'timeout';
const CODES = new Set<EgressCode>(['refused', 'unavailable', 'failed', 'timeout']);

export class EgressError extends Error {
  constructor(
    readonly code: EgressCode,
    message: string = code,
  ) {
    super(message);
  }
}

function frame(type: number, id: number, payload?: Buffer): Buffer {
  const b = Buffer.allocUnsafe(HEADER + (payload?.length ?? 0));
  b.writeUInt8(type, 0);
  b.writeUInt32BE(id, 1);
  payload?.copy(b, HEADER);
  return b;
}

/** One stream as a duplex: what is written goes to the other end, what arrives can be read. */
class Channel extends Duplex {
  /** Sent and not yet reported used by the other end; past WINDOW the next write waits here. */
  private inflight = 0;
  private waiting: (() => void) | null = null;
  /** Arrived from the other end, and how much of it was reported used. */
  private received = 0;
  private acked = 0;
  private sentEnd = false;
  private gotEnd = false;
  private over = false;

  constructor(
    private mux: EgressMux,
    readonly id: number,
  ) {
    super({ allowHalfOpen: true });
    // A stream may end with an error before anyone listens (a failed open, a lost channel); that
    // must not bring the process down. Whoever uses the stream adds its own listener.
    this.on('error', () => {});
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void) {
    for (let i = 0; i < chunk.length; i += MAX_CHUNK) {
      this.mux.send(frame(DATA, this.id, chunk.subarray(i, i + MAX_CHUNK)));
    }
    this.inflight += chunk.length;
    if (this.inflight >= WINDOW) this.waiting = () => cb();
    else cb();
  }

  override _final(cb: (err?: Error | null) => void) {
    this.sentEnd = true;
    this.mux.send(frame(END, this.id));
    cb();
  }

  /**
   * The reader wants more. It may empty what is buffered without asking again, so everything read
   * so far is reported now; otherwise a full window would wait for a report that never comes.
   */
  override _read() {
    this.ack(true);
  }

  /**
   * Every read, by a reader or a pipe, goes through here; what it took is reported once it adds
   * up. `_read` alone is not enough: it is not called again until more arrives.
   */
  override read(size?: number) {
    const chunk: unknown = super.read(size);
    this.ack();
    return chunk;
  }

  /** Tells the other end how much of what arrived has been read since it last heard. */
  private ack(now = false) {
    const used = this.received - this.readableLength - this.acked;
    if (used <= 0 || (!now && used < ACK_STEP && this.readableLength > 0)) return;
    this.acked += used;
    const n = Buffer.allocUnsafe(4);
    n.writeUInt32BE(used, 0);
    this.mux.send(frame(ACK, this.id, n));
  }

  override _destroy(err: Error | null, cb: (err?: Error | null) => void) {
    if (!this.over) {
      this.over = true;
      // Both sides ended on their own: the other end closes too, without being told.
      if (!(this.sentEnd && this.gotEnd)) this.mux.send(frame(RESET, this.id));
    }
    this.mux.forget(this.id);
    this.waiting = null;
    cb(err);
  }

  arrived(data: Buffer) {
    if (this.gotEnd || this.destroyed) return;
    this.received += data.length;
    this.push(data);
    this.ack();
  }

  ended() {
    if (this.gotEnd) return;
    this.gotEnd = true;
    this.push(null);
  }

  credit(n: number) {
    this.inflight = Math.max(0, this.inflight - n);
    if (this.inflight >= WINDOW) return;
    const w = this.waiting;
    this.waiting = null;
    w?.();
  }

  /** The other end is gone: nothing more is sent to it. */
  reset(err?: Error) {
    this.over = true;
    this.destroy(err ?? new EgressError('failed', 'connection reset'));
  }
}

export interface EgressMuxOptions {
  /** Puts one frame on the channel. */
  send(frame: Buffer): void;
  /** On the exit side: makes the connection an open asks for. */
  dial?(host: string, port: number): Promise<Duplex>;
  openTimeoutMs?: number;
  maxStreams?: number;
}

interface Opening {
  resolve(ch: Channel): void;
  reject(err: EgressError): void;
  timer: NodeJS.Timeout;
}

/**
 * The streams on one channel. The entry side opens them (`open`), the exit side makes the
 * connections (`dial`); each side calls `receive` with every frame that arrives and `close` when
 * the channel goes away.
 */
export class EgressMux {
  private streams = new Map<number, Channel>();
  private opening = new Map<number, Opening>();
  private next = 1;
  private closed = false;

  constructor(private opts: EgressMuxOptions) {}

  get size() {
    return this.streams.size;
  }

  /** @internal */
  send(f: Buffer) {
    if (!this.closed) this.opts.send(f);
  }

  /** @internal */
  forget(id: number) {
    this.streams.delete(id);
  }

  /** Opens a connection to `host:port` at the exit. */
  open(host: string, port: number): Promise<Duplex> {
    if (this.closed) return Promise.reject(new EgressError('unavailable'));
    if (this.streams.size >= (this.opts.maxStreams ?? MAX_STREAMS)) {
      return Promise.reject(new EgressError('failed', 'too many connections'));
    }
    const id = this.next;
    this.next = this.next >= 0xffffffff ? 1 : this.next + 1;
    const ch = new Channel(this, id);
    this.streams.set(id, ch);
    return new Promise<Duplex>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.opening.delete(id);
        ch.destroy();
        reject(new EgressError('timeout'));
      }, this.opts.openTimeoutMs ?? OPEN_TIMEOUT_MS);
      this.opening.set(id, { resolve, reject, timer });
      this.send(frame(OPEN, id, Buffer.from(JSON.stringify({ host, port }))));
    });
  }

  receive(f: Buffer) {
    if (this.closed || f.length < HEADER) return;
    const type = f.readUInt8(0);
    const id = f.readUInt32BE(1);
    const payload = f.subarray(HEADER);
    if (type === OPEN) return void this.accept(id, payload);
    const ch = this.streams.get(id);
    const o = this.opening.get(id);
    switch (type) {
      case OPENED:
        if (o && ch) {
          clearTimeout(o.timer);
          this.opening.delete(id);
          o.resolve(ch);
        }
        return;
      case ERROR: {
        if (!o) return;
        clearTimeout(o.timer);
        this.opening.delete(id);
        const code = payload.toString('utf8') as EgressCode;
        this.streams.delete(id);
        ch?.reset();
        o.reject(new EgressError(CODES.has(code) ? code : 'failed'));
        return;
      }
      case DATA:
        return ch?.arrived(Buffer.from(payload));
      case END:
        return ch?.ended();
      case RESET:
        if (o) {
          clearTimeout(o.timer);
          this.opening.delete(id);
          o.reject(new EgressError('failed', 'connection reset'));
        }
        return ch?.reset();
      case ACK:
        if (payload.length === 4) ch?.credit(payload.readUInt32BE(0));
        return;
    }
  }

  /** The channel is gone: every stream on it ends. */
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const [id, o] of this.opening) {
      clearTimeout(o.timer);
      o.reject(new EgressError('unavailable'));
      this.opening.delete(id);
    }
    for (const ch of [...this.streams.values()]) ch.reset(new EgressError('unavailable'));
    this.streams.clear();
  }

  private async accept(id: number, payload: Buffer) {
    const fail = (code: EgressCode) => this.send(frame(ERROR, id, Buffer.from(code)));
    if (!this.opts.dial || this.streams.has(id)) return fail('unavailable');
    if (this.streams.size >= (this.opts.maxStreams ?? MAX_STREAMS)) return fail('failed');
    let target: { host: string; port: number };
    try {
      target = OpenTarget(JSON.parse(payload.toString('utf8')));
    } catch {
      return fail('refused');
    }
    const ch = new Channel(this, id);
    this.streams.set(id, ch);
    let conn: Duplex;
    try {
      conn = await this.opts.dial(target.host, target.port);
    } catch (err) {
      // Already reset by the entry (it gave up), or the channel is gone: nobody waits for an answer.
      const gone = ch.destroyed || this.closed;
      this.streams.delete(id);
      if (gone) return;
      ch.reset();
      return fail(err instanceof EgressError ? err.code : 'failed');
    }
    // The entry gave up (a reset, a timeout) or the channel went away while connecting.
    if (ch.destroyed || this.closed) return void conn.destroy();
    this.send(frame(OPENED, id));
    join(ch, conn);
  }
}

function OpenTarget(v: unknown): { host: string; port: number } {
  const o = v as { host?: unknown; port?: unknown };
  if (typeof o?.host !== 'string' || !o.host || o.host.length > 255) throw new Error('bad host');
  if (typeof o.port !== 'number' || !Number.isInteger(o.port) || o.port < 1 || o.port > 65535) {
    throw new Error('bad port');
  }
  return { host: o.host, port: o.port };
}

/**
 * Joins two duplexes both ways. When one breaks, the other is closed too; one that ended cleanly
 * in both directions leaves the other to finish what it still has to write.
 */
export function join(a: Duplex, b: Duplex) {
  a.pipe(b);
  b.pipe(a);
  const kill = () => {
    a.destroy();
    b.destroy();
  };
  const closed = (s: Duplex, other: Duplex) => () => {
    if (!(s.readableEnded && s.writableFinished)) other.destroy();
  };
  a.on('error', kill);
  b.on('error', kill);
  a.on('close', closed(a, b));
  b.on('close', closed(b, a));
}

// ---- SOCKS5 --------------------------------------------------------------------------------

/** SOCKS5 reply codes. */
export const SOCKS_REPLY = {
  ok: 0,
  failed: 1,
  notAllowed: 2,
  unreachable: 4,
  refused: 5,
  timeout: 6,
  badCommand: 7,
  badAddress: 8,
} as const;

/** The SOCKS5 reply code for why a connection could not be made. */
export function socksReplyFor(err: unknown): number {
  if (!(err instanceof EgressError)) return SOCKS_REPLY.failed;
  if (err.code === 'refused') return SOCKS_REPLY.notAllowed;
  if (err.code === 'timeout') return SOCKS_REPLY.timeout;
  if (err.code === 'unavailable') return SOCKS_REPLY.unreachable;
  return SOCKS_REPLY.refused;
}

const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Greets a SOCKS5 client (no sign-in) and reads where it wants to connect; only CONNECT is
 * served. The caller answers with `socksReply` once it knows.
 */
export function socksAccept(sock: Socket): Promise<{ host: string; port: number }> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let greeted = false;
    const finish = () => {
      clearTimeout(timer);
      // Paused before the reader goes: a flowing socket without a reader drops what arrives.
      sock.pause();
      sock.off('data', onData);
      sock.off('error', onError);
      sock.off('close', onClose);
    };
    const done = (err: Error | null, target?: { host: string; port: number }, rest?: Buffer) => {
      finish();
      if (err) {
        sock.destroy();
        return reject(err);
      }
      if (rest?.length) sock.unshift(rest);
      resolve(target!);
    };
    const refuse = (reply: Buffer, why: string) => {
      finish();
      sock.end(reply);
      reject(new Error(why));
    };
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > 1024) return done(new Error('handshake too long'));
      if (!greeted) {
        if (buf.length < 2) return;
        if (buf[0] !== 5) return done(new Error('not SOCKS5'));
        const n = buf[1]!;
        if (buf.length < 2 + n) return;
        const methods = buf.subarray(2, 2 + n);
        buf = buf.subarray(2 + n);
        if (!methods.includes(0)) return refuse(Buffer.from([5, 0xff]), 'no usable method');
        greeted = true;
        sock.write(Buffer.from([5, 0]));
      }
      if (buf.length < 5) return;
      if (buf[0] !== 5) return done(new Error('bad request'));
      const cmd = buf[1]!;
      const atyp = buf[3]!;
      let host: string;
      let at: number;
      if (atyp === 1) {
        if (buf.length < 10) return;
        host = [...buf.subarray(4, 8)].join('.');
        at = 8;
      } else if (atyp === 3) {
        const len = buf[4]!;
        if (buf.length < 5 + len + 2) return;
        host = buf.subarray(5, 5 + len).toString('latin1');
        at = 5 + len;
      } else if (atyp === 4) {
        if (buf.length < 22) return;
        const words: string[] = [];
        for (let i = 4; i < 20; i += 2) words.push(buf.readUInt16BE(i).toString(16));
        host = words.join(':');
        at = 20;
      } else {
        return refuse(socksReplyFrame(SOCKS_REPLY.badAddress), 'bad address type');
      }
      const port = buf.readUInt16BE(at);
      if (cmd !== 1) return refuse(socksReplyFrame(SOCKS_REPLY.badCommand), 'only CONNECT');
      if (!host || port === 0) return refuse(socksReplyFrame(SOCKS_REPLY.badAddress), 'bad address');
      done(null, { host, port }, buf.subarray(at + 2));
    };
    const onError = (e: Error) => done(e);
    const onClose = () => done(new Error('closed'));
    const timer = setTimeout(() => done(new Error('handshake timed out')), HANDSHAKE_TIMEOUT_MS);
    sock.on('data', onData);
    sock.on('error', onError);
    sock.on('close', onClose);
  });
}

function socksReplyFrame(code: number): Buffer {
  return Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);
}

/**
 * Answers the client's CONNECT: `SOCKS_REPLY.ok` before the socket is joined to its connection
 * (which starts reading it), any other code ends it.
 */
export function socksReply(sock: Socket, code: number) {
  if (code === SOCKS_REPLY.ok) sock.write(socksReplyFrame(code));
  else sock.end(socksReplyFrame(code));
}

// ---- reaching only the public internet -----------------------------------------------------

function ipv4Blocked(ip: string): boolean {
  const [a, b, c] = ip.split('.').map(Number) as [number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    // Documentation ranges and the old 6to4 relay: nothing a page has reason to reach.
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** The eight 16-bit words of an IPv6 address, or null when it is not one. */
function ipv6Words(ip: string): number[] | null {
  let text = ip.toLowerCase().split('%')[0]!;
  if (text.includes('.')) {
    // A dotted IPv4 tail (::ffff:1.2.3.4) is two words.
    const at = text.lastIndexOf(':');
    const v4 = text.slice(at + 1);
    if (isIP(v4) !== 4) return null;
    const p = v4.split('.').map(Number) as [number, number, number, number];
    text = `${text.slice(0, at + 1)}${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const read = (s: string) => (s ? s.split(':') : []);
  const head = read(halves[0]!);
  const rest = halves.length === 2 ? read(halves[1]!) : [];
  const fill = 8 - head.length - rest.length;
  // "::" stands for at least one zero word.
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const words = [...head, ...new Array<string>(fill).fill('0'), ...rest].map((w) =>
    /^[0-9a-f]{1,4}$/.test(w) ? parseInt(w, 16) : NaN,
  );
  return words.every(Number.isInteger) ? words : null;
}

const v4From = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/**
 * Whether an address must not be reached through the person's computer: that computer itself,
 * its home or office network, link-local, multicast and reserved ranges, also when an IPv6 form
 * carries one of them inside.
 */
export function blockedAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return ipv4Blocked(ip);
  if (v !== 6) return true;
  const w = ipv6Words(ip);
  if (!w) return true;
  if (w.every((x) => x === 0)) return true; // ::
  if (w.slice(0, 7).every((x) => x === 0) && w[7] === 1) return true; // ::1
  // ::ffff:a.b.c.d and the old ::a.b.c.d
  if (w.slice(0, 5).every((x) => x === 0) && (w[5] === 0xffff || w[5] === 0)) {
    return ipv4Blocked(v4From(w[6]!, w[7]!));
  }
  // ::ffff:0:a.b.c.d, the translated form some stacks still accept
  if (w.slice(0, 4).every((x) => x === 0) && w[4] === 0xffff && w[5] === 0) {
    return ipv4Blocked(v4From(w[6]!, w[7]!));
  }
  // NAT64 for the operator's own network (64:ff9b:1::/48) leads wherever it was set up to.
  if (w[0] === 0x64 && w[1] === 0xff9b && w[2] === 1) return true;
  if (w[0] === 0x64 && w[1] === 0xff9b) return ipv4Blocked(v4From(w[6]!, w[7]!)); // NAT64
  if (w[0] === 0x2002) return ipv4Blocked(v4From(w[1]!, w[2]!)); // 6to4
  // Teredo hides the IPv4 address it reaches; documentation and discard ranges reach nothing.
  if (w[0] === 0x2001 && (w[1] === 0 || w[1] === 0xdb8)) return true;
  if (w[0] === 0x100 && w[1] === 0 && w[2] === 0 && w[3] === 0) return true;
  const first = w[0]!;
  return (
    (first & 0xfe00) === 0xfc00 || // unique local
    (first & 0xffc0) === 0xfe80 || // link-local
    (first & 0xffc0) === 0xfec0 || // site-local
    (first & 0xff00) === 0xff00 // multicast
  );
}

export interface DialOptions {
  /** Only these ports; null for any. */
  ports?: readonly number[] | null;
  /** Names or addresses reached even though they are private, as set by the operator. */
  allowHosts?: readonly string[];
  /** Any address: for a caller whose own network is already walled off from private ones. */
  anyAddress?: boolean;
  timeoutMs?: number;
  /** Tests pass stand-ins. */
  lookup?: (host: string) => Promise<{ address: string }[]>;
  connect?: (address: string, port: number) => Socket;
}

/** The ports a site is reached on: the web's own. */
export const WEB_PORTS = [80, 443] as const;

/**
 * Connects to `host:port` only if it is on the public internet. The name is looked up here and
 * the connection goes to the address found, so a name cannot be turned into a private address
 * between the check and the connection.
 */
export async function dialPublic(host: string, port: number, o: DialOptions = {}): Promise<Socket> {
  if (o.ports && !o.ports.includes(port)) throw new EgressError('refused', `port ${port}`);
  const name = host.replace(/^\[|\]$/g, '').toLowerCase();
  let address: string;
  if (o.anyAddress || o.allowHosts?.includes(name)) {
    address = name;
  } else if (isIP(name)) {
    if (blockedAddress(name)) throw new EgressError('refused', name);
    address = name;
  } else {
    if (!name || name === 'localhost' || name.endsWith('.localhost')) throw new EgressError('refused', name);
    const found = await (o.lookup ?? ((h) => dnsLookup(h, { all: true })))(name).catch(() => []);
    if (!found.length) throw new EgressError('failed', `cannot resolve ${name}`);
    if (found.some((a) => blockedAddress(a.address))) throw new EgressError('refused', name);
    address = found[0]!.address;
  }
  const sock = (o.connect ?? ((a, p) => netConnect({ host: a, port: p, allowHalfOpen: true })))(
    address,
    port,
  );
  return new Promise<Socket>((resolve, reject) => {
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new EgressError('timeout'));
    }, o.timeoutMs ?? 20_000);
    sock.once('connect', () => {
      clearTimeout(timer);
      sock.off('error', onError);
      resolve(sock);
    });
    const onError = (e: Error) => {
      clearTimeout(timer);
      reject(new EgressError('failed', e.message));
    };
    sock.once('error', onError);
  });
}
