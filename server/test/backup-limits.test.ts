import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { Bot } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schemaVersion } from '../src/db';
import { BACKUP_MAGIC, BACKUP_SCRYPT, MAX_TABLE_BYTES } from '../src/services/backup';
import { BOUND_FILE } from '../src/services/vault';
import { AUTH, testServer, type TestServer } from './helpers';

const PASSWORD = 'yedek-şifresi-2026';
const LEGACY_MAGIC = Buffer.from('LEAFBK1');

/** The gzip inside a backup made now, opened with its password. */
function openBackup(file: Buffer, password: string): Buffer {
  const at = BACKUP_MAGIC.length;
  const [logN, r, p] = [file[at]!, file[at + 1]!, file[at + 2]!];
  const salt = file.subarray(at + 3, at + 19);
  const iv = file.subarray(at + 19, at + 31);
  const N = 2 ** logN;
  const key = scryptSync(password.normalize('NFC'), salt, 32, { N, r, p, maxmem: 2 * 128 * N * r });
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(file.subarray(0, at + 31));
  d.setAuthTag(file.subarray(file.length - 16));
  return Buffer.concat([d.update(file.subarray(at + 31, file.length - 16)), d.final()]);
}

/** A backup as versions before the cost was kept in the file made it. */
function legacyBackup(gzipped: Buffer, password: string): Buffer {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(password.normalize('NFC'), salt, 32, {
    N: 2 ** 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  const c = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(gzipped), c.final()]);
  return Buffer.concat([LEGACY_MAGIC, salt, iv, data, c.getAuthTag()]);
}

function record(header: object): Buffer {
  const json = Buffer.from(JSON.stringify(header));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(json.length);
  return Buffer.concat([len, json]);
}

const manifest = () =>
  record({
    type: 'manifest',
    format: 'leafbot-backup',
    version: 1,
    schema: schemaVersion(),
    createdAt: new Date().toISOString(),
    size: 0,
  });

describe('yedeğin anahtar maliyeti ve boyut sınırları', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const download = async () => {
    const made = await t.api<{ id: string }>('POST', '/api/backup', { password: PASSWORD });
    expect(made.status).toBe(200);
    return (await t.app.inject({ method: 'GET', url: `/api/backup/${made.body.id}`, headers: AUTH }))
      .rawPayload;
  };
  const restore = (file: Buffer, password = PASSWORD) =>
    t.app.inject({
      method: 'POST',
      url: '/api/backup/restore',
      headers: {
        ...AUTH,
        'content-type': 'application/octet-stream',
        'x-backup-password': encodeURIComponent(password),
      },
      payload: file,
    });
  const botNames = async () => (await t.api<Bot[]>('GET', '/api/bots')).body.map((b) => b.name).sort();

  it('yeni yedek maliyetini başlığında taşır; eski biçimdeki yedek de geri yüklenir', async () => {
    await t.bot({ name: 'Ali' });
    // A saved sign-in binds the vault's table; a restore must let the restored rows be bound again.
    await t.api('POST', '/api/vault', { site: 'site.example', username: 'ali', password: 'parola-1' });
    expect(existsSync(join(t.dataDir, BOUND_FILE))).toBe(true);
    const file = await download();
    const at = BACKUP_MAGIC.length;
    expect([2 ** file[at]!, file[at + 1], file[at + 2]]).toEqual([
      BACKUP_SCRYPT.N,
      BACKUP_SCRYPT.r,
      BACKUP_SCRYPT.p,
    ]);
    expect(BACKUP_SCRYPT.N).toBeGreaterThanOrEqual(2 ** 17);

    // A lowered cost in the head is a change to the file like any other.
    const cheaper = Buffer.from(file);
    cheaper[at] = 14;
    expect((await restore(cheaper)).statusCode).toBe(400);

    const old = legacyBackup(openBackup(file, PASSWORD), PASSWORD);
    await t.bot({ name: 'Veli' });
    const restarted = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ok = await restore(old);
    expect(ok.statusCode).toBe(200);
    expect(await botNames()).toEqual(['Ali']);
    expect(existsSync(join(t.dataDir, BOUND_FILE))).toBe(false);
    await vi.waitFor(() => expect(restarted).toHaveBeenCalled());
    restarted.mockRestore();
  });

  it('başlığının söylediği boyut sınırı aşan ya da geçersiz olan yedeği açmaz', async () => {
    await t.bot({ name: 'Ali' });
    const tooBig = legacyBackup(
      gzipSync(
        Buffer.concat([manifest(), record({ type: 'table', name: 'bots', size: MAX_TABLE_BYTES + 1 })]),
      ),
      PASSWORD,
    );
    const refused = await restore(tooBig);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toContain('büyük');

    const hugeFile = legacyBackup(
      gzipSync(
        Buffer.concat([manifest(), record({ type: 'file', path: 'vault.key', size: 2 ** 40, mode: 0o600 })]),
      ),
      PASSWORD,
    );
    expect((await restore(hugeFile)).json().error).toContain('büyük');

    const negative = legacyBackup(
      gzipSync(Buffer.concat([manifest(), record({ type: 'table', name: 'bots', size: -5 })])),
      PASSWORD,
    );
    expect((await restore(negative)).statusCode).toBe(400);
    expect(await botNames()).toEqual(['Ali']);
  });

  it('tablo verisi bozuksa hiçbir satırı değiştirmez', async () => {
    await t.bot({ name: 'Ali' });
    const rows = Buffer.from('{"bu bir dizi değil": true}');
    const file = legacyBackup(
      gzipSync(Buffer.concat([manifest(), record({ type: 'table', name: 'bots', size: rows.length }), rows])),
      PASSWORD,
    );
    const r = await restore(file);
    expect(r.statusCode).toBe(400);
    expect(await botNames()).toEqual(['Ali']);
  });
});
