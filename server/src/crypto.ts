import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV_BYTES = 12;
/** GCM's full tag. A shorter one would still be accepted by Node and is far easier to forge. */
const TAG_BYTES = 16;

/**
 * AES-256-GCM as the server keeps secrets and sealed content: `iv:tag:data`, each base64. The
 * caller puts its own marker in front (`v1:`/`v2:` for the vault, `yb1:` for content at rest).
 * `aad` is data the text is bound to without being sealed with it, such as the row and the site a
 * password belongs to: the text opens only with the same `aad`, so a sealed value moved to another
 * row, or left in a row whose site was changed, no longer opens.
 */
export function sealWith(key: Buffer, plain: string, aad?: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const c = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  if (aad) c.setAAD(aad);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${data.toString('base64')}`;
}

/** The text of `iv:tag:data`; throws when the key or `aad` is not the one it was sealed with. */
export function openWith(key: Buffer, sealed: string, aad?: Buffer): string {
  const [iv, tag, data, extra] = sealed.split(':');
  if (!iv || !tag || data === undefined || extra !== undefined) throw new Error('Unknown sealed format');
  const ivBytes = Buffer.from(iv, 'base64');
  const tagBytes = Buffer.from(tag, 'base64');
  if (ivBytes.length !== IV_BYTES || tagBytes.length !== TAG_BYTES) throw new Error('Unknown sealed format');
  const d = createDecipheriv('aes-256-gcm', key, ivBytes, { authTagLength: TAG_BYTES });
  d.setAuthTag(tagBytes);
  if (aad) d.setAAD(aad);
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}
