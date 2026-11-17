import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { customType } from 'drizzle-orm/pg-core';

/**
 * Content sealed at rest: conversation text, prompts, memory and mail are written to the database
 * encrypted (AES-256-GCM) while sealing is on, so a copy of the database (a dump, a backup of the
 * Postgres server, a disk) does not reveal them. The key comes from the vault key in the data
 * folder, which the database never holds.
 *
 * A sealed value starts with `yb1:`; anything else is read as it is, so sealed and plain rows live
 * side by side while existing rows are converted. One server runs per process, so the key and the
 * switch are the process's.
 */
const PREFIX = 'yb1:';
let key: Buffer | null = null;
let sealing = false;

export function setContentKey(k: Buffer | null) {
  key = k;
}

/** Whether new writes are sealed; reads open sealed values either way. */
export function setSealing(on: boolean) {
  sealing = on && !!key;
}

export const contentSealed = () => sealing;

export function sealText(v: string): string {
  if (!sealing || !key || !v || v.startsWith(PREFIX)) return v;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(v, 'utf8'), c.final()]);
  return `${PREFIX}${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${data.toString('base64')}`;
}

export function openText(v: string): string {
  if (typeof v !== 'string' || !v.startsWith(PREFIX)) return v;
  const [iv, tag, data] = v.slice(PREFIX.length).split(':');
  if (!key || !iv || !tag || data === undefined) return '';
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch {
    // Sealed with another key (a database moved without its data folder): unreadable, not an error.
    return '';
  }
}

/** Whether a value as stored is sealed. */
export const isSealed = (v: unknown) => typeof v === 'string' && v.startsWith(PREFIX);

/** A text column sealed at rest while sealing is on; the database sees plain `text`. */
export const sealedText = customType<{ data: string; driverData: string }>({
  dataType: () => 'text',
  toDriver: (v) => sealText(v),
  fromDriver: (v) => openText(v),
});
