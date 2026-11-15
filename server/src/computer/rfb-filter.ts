/**
 * Reads what a viewer sends to a desktop's screen server (RFB, the VNC protocol) and drops mouse,
 * keyboard and clipboard messages unless that viewer's person has control. The check is here,
 * not only in the app, so a viewer that ignores "view only" still cannot type into the desktop.
 *
 * Client messages after the handshake (type byte first):
 *   0 SetPixelFormat 20 · 2 SetEncodings 4+4n · 3 FramebufferUpdateRequest 10 · 4 KeyEvent 8 ·
 *   5 PointerEvent 6, or 7 when the top bit of the button mask marks extended buttons ·
 *   6 ClientCutText 8+n · 150 EnableContinuousUpdates 10 · 248 Fence 9+n ·
 *   255/0 QEMU extended KeyEvent 12 (sent instead of KeyEvent when the server offers it) ·
 *   251 SetDesktopSize 8+16n (dropped: the desktop keeps its size) · 250 xvp 4 (dropped).
 * Anything else ends the connection, since its length is unknown.
 */
const INPUT = new Set([4, 5, 6, 255]);
const DROPPED = new Set([250, 251]);
/** Clipboard text larger than this is refused. */
const MAX_CUT = 1 << 20;

export class RfbClientFilter {
  /** Handshake bytes still to pass untouched: version (12), security type (1), ClientInit (1). */
  private handshake = 14;
  private buf = Buffer.alloc(0);

  constructor(private canInput: () => boolean) {}

  /** The bytes to forward, or an error when the stream cannot be understood. */
  push(chunk: Uint8Array): { out: Buffer } | { error: string } {
    let data = Buffer.from(chunk);
    const out: Buffer[] = [];
    if (this.handshake > 0) {
      const n = Math.min(this.handshake, data.length);
      out.push(data.subarray(0, n));
      this.handshake -= n;
      data = data.subarray(n);
    }
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : data;
    while (this.buf.length > 0) {
      const len = messageLength(this.buf);
      if (len === 'unknown') return { error: `unknown message type ${this.buf[0]}` };
      if (len === 'tooBig') return { error: 'message too large' };
      if (len === null || this.buf.length < len) break;
      const msg = this.buf.subarray(0, len);
      this.buf = this.buf.subarray(len);
      const type = msg[0]!;
      if (DROPPED.has(type)) continue;
      if (INPUT.has(type) && !this.canInput()) continue;
      out.push(msg);
    }
    return { out: Buffer.concat(out) };
  }
}

/** The full length of the message at the start of `b`; null when more bytes are needed to tell. */
function messageLength(b: Buffer): number | null | 'unknown' | 'tooBig' {
  switch (b[0]) {
    case 0:
      return 20;
    case 2:
      return b.length < 4 ? null : 4 + 4 * b.readUInt16BE(2);
    case 3:
      return 10;
    case 4:
      return 8;
    case 5:
      return b.length < 2 ? null : b[1]! & 0x80 ? 7 : 6;
    case 6: {
      if (b.length < 8) return null;
      // A negative length marks the extended clipboard format; its size is the absolute value.
      const n = Math.abs(b.readInt32BE(4));
      return n > MAX_CUT ? 'tooBig' : 8 + n;
    }
    case 150:
      return 10;
    case 248:
      return b.length < 9 ? null : 9 + b[8]!;
    case 250:
      return 4;
    case 251:
      return b.length < 7 ? null : 8 + 16 * b[6]!;
    case 255:
      // Only the extended key event of the QEMU messages is known.
      return b.length < 2 ? null : b[1] === 0 ? 12 : 'unknown';
    default:
      return 'unknown';
  }
}
