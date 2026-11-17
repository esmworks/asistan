import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM as the server keeps secrets and sealed content: `iv:tag:data`, each base64. The
 * caller puts its own marker in front (`v1:` for the vault, `yb1:` for content at rest).
 */
export function sealWith(key: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${data.toString('base64')}`;
}

/** The text of `iv:tag:data`; throws when the key is not the one it was sealed with. */
export function openWith(key: Buffer, sealed: string): string {
  const [iv, tag, data] = sealed.split(':');
  if (!iv || !tag || data === undefined) throw new Error('Unknown sealed format');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}
