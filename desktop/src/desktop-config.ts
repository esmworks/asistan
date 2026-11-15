import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { t } from './i18n';

export type DesktopConfig = { mode: 'local' } | { mode: 'remote'; url: string; key: string };

interface Stored {
  mode: 'local' | 'remote';
  url?: string;
  /** Access key encrypted with the OS keychain (base64). */
  keyEncrypted?: string;
}

export interface Crypto {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
}

export function readDesktopConfig(dir: string, crypto: Crypto): DesktopConfig {
  const file = join(dir, 'desktop.json');
  if (!existsSync(file)) return { mode: 'local' };
  try {
    const s = JSON.parse(readFileSync(file, 'utf8')) as Stored;
    if (s.mode === 'remote' && s.url && s.keyEncrypted && crypto.isEncryptionAvailable()) {
      return { mode: 'remote', url: s.url, key: crypto.decryptString(Buffer.from(s.keyEncrypted, 'base64')) };
    }
  } catch {
    // Unreadable config falls back to the local server.
  }
  return { mode: 'local' };
}

export function writeDesktopConfig(dir: string, cfg: DesktopConfig, crypto: Crypto) {
  let stored: Stored = { mode: 'local' };
  if (cfg.mode === 'remote') {
    if (!crypto.isEncryptionAvailable()) throw new Error(t('error.noKeychain'));
    stored = { mode: 'remote', url: cfg.url, keyEncrypted: crypto.encryptString(cfg.key).toString('base64') };
  }
  writeFileSync(join(dir, 'desktop.json'), JSON.stringify(stored, null, 2), { mode: 0o600 });
}

/** Remote servers must use HTTPS, except on the local network for testing. */
export function normalizeRemoteUrl(input: string): string {
  const u = new URL(input.trim());
  const local = /^(localhost|127\.0\.0\.1|\[::1\]|.+\.local)$/.test(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    throw new Error(t('error.httpsRequired'));
  }
  return u.origin;
}
