import type { ComputerAck } from '@leafbot/shared';

/** The part of the socket.io client the channel uses; a fake can stand in for it in tests. */
export interface VncSocket {
  connected: boolean;
  emit(event: 'vnc:open', botId: string, ack: (r: ComputerAck) => void): unknown;
  emit(event: 'vnc:data', e: { botId: string; data: Uint8Array }): unknown;
  emit(event: 'vnc:close', botId: string): unknown;
  on(event: 'vnc:data', fn: (e: { botId: string; data: ArrayBuffer | Uint8Array }) => void): unknown;
  on(event: 'vnc:closed', fn: (e: { botId: string }) => void): unknown;
  on(event: 'disconnect', fn: () => void): unknown;
  off(event: 'vnc:data', fn: (e: { botId: string; data: ArrayBuffer | Uint8Array }) => void): unknown;
  off(event: 'vnc:closed', fn: (e: { botId: string }) => void): unknown;
  off(event: 'disconnect', fn: () => void): unknown;
}

// WebSocket readyState values; the viewer reads them as it would on a WebSocket.
const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

function toBuffer(data: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  // A view may cover only part of a larger buffer.
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

/**
 * A WebSocket-like channel over the app's socket.io connection, which the noVNC viewer accepts in
 * place of a URL. The server relays the bytes to the desktop's screen; nothing else is exposed.
 */
export class VncChannel {
  binaryType = 'arraybuffer';
  protocol = '';
  onopen: ((e: unknown) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;

  private state = CONNECTING;
  private handler: ((e: { data: ArrayBuffer }) => void) | null = null;
  /** Bytes that arrived before the viewer attached its handler. */
  private early: ArrayBuffer[] = [];

  constructor(
    private readonly socket: VncSocket,
    private readonly botId: string,
  ) {
    socket.on('vnc:data', this.onData);
    socket.on('vnc:closed', this.onClosed);
    socket.on('disconnect', this.onDisconnect);
    if (!socket.connected) {
      queueMicrotask(() => this.fail());
      return;
    }
    socket.emit('vnc:open', botId, (r) => {
      if (this.state !== CONNECTING) return;
      if (!r.ok) return this.fail();
      this.state = OPEN;
      this.onopen?.({});
    });
  }

  get readyState(): number {
    return this.state;
  }

  get onmessage(): ((e: { data: ArrayBuffer }) => void) | null {
    return this.handler;
  }

  set onmessage(fn: ((e: { data: ArrayBuffer }) => void) | null) {
    this.handler = fn;
    if (!fn) return;
    for (const data of this.early.splice(0)) fn({ data });
  }

  send(data: ArrayBuffer | ArrayBufferView) {
    if (this.state !== OPEN) return;
    // Copied: the viewer reuses its send buffer while the socket may still be holding this one.
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data.slice(0))
        : new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    this.socket.emit('vnc:data', { botId: this.botId, data: bytes });
  }

  close() {
    if (this.state === CLOSING || this.state === CLOSED) return;
    const wasOpen = this.state === OPEN;
    this.state = CLOSING;
    this.detach();
    if (wasOpen || this.socket.connected) this.socket.emit('vnc:close', this.botId);
    // Like a WebSocket, the close event follows asynchronously.
    setTimeout(() => this.finish(), 0);
  }

  private readonly onData = (e: { botId: string; data: ArrayBuffer | Uint8Array }) => {
    if (e.botId !== this.botId || this.state !== OPEN) return;
    const data = toBuffer(e.data);
    if (this.handler) this.handler({ data });
    else this.early.push(data);
  };

  private readonly onClosed = (e: { botId: string }) => {
    if (e.botId === this.botId) this.finish();
  };

  private readonly onDisconnect = () => this.finish();

  private detach() {
    this.socket.off('vnc:data', this.onData);
    this.socket.off('vnc:closed', this.onClosed);
    this.socket.off('disconnect', this.onDisconnect);
  }

  /** The server refused or could not be reached: report an error, then the close. */
  private fail() {
    if (this.state === CLOSED) return;
    this.onerror?.({});
    this.finish();
  }

  private finish() {
    if (this.state === CLOSED) return;
    this.state = CLOSED;
    this.detach();
    this.early = [];
    this.onclose?.({});
  }
}
