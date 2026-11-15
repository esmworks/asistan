import { createHmac } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32 (RFC 4648) to bytes; spaces, dashes and padding are ignored. Null when not base32. */
export function base32(text: string): Buffer | null {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  if (!clean || /[^A-Z2-7]/.test(clean)) return null;
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * The secret of an authenticator setup: the base32 text a site shows, or the `otpauth://` link in
 * its QR code. Null when it is neither.
 */
export function totpSecret(input: string): string | null {
  const raw = input.trim();
  let secret = raw;
  if (/^otpauth:\/\//i.test(raw)) {
    try {
      secret = new URL(raw).searchParams.get('secret') ?? '';
    } catch {
      return null;
    }
  }
  const clean = secret.toUpperCase().replace(/[\s=-]/g, '');
  return base32(clean)?.length ? clean : null;
}

/** The six-digit code of a time-based one-time password (RFC 6238, SHA-1, 30 seconds). */
export function totp(secret: string, at = Date.now(), digits = 6, step = 30): string {
  const key = base32(secret);
  if (!key) throw new Error('Invalid authenticator secret');
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / step)));
  const mac = createHmac('sha1', key).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const n = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(n).padStart(digits, '0');
}
