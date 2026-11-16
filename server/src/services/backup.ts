import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCb,
  type ScryptOptions,
} from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { PassThrough, Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { getTableColumns, getTableName, inArray, is, sql } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import type { Ctx } from '../context';
import { schema, schemaVersion } from '../db';
import { HttpError, newId } from '../util';

/**
 * One file that holds everything needed to bring a Yumak Bot back on another computer: the
 * database, the bots' folders and Pi sessions, and the vault key (without it the saved passwords
 * and tokens in the database cannot be opened). It is sealed with a password the person chooses,
 * so the file can be kept anywhere.
 *
 * Layout: `YUMAKBK1`, a 16-byte salt, a 12-byte IV, the AES-256-GCM ciphertext, and its 16-byte
 * tag. The key comes from the password with scrypt. Inside, gzip of a run of records: each is a
 * 4-byte length, a JSON header, then `header.size` bytes (a table's rows as JSON, or a file).
 */
export const BACKUP_MAGIC = Buffer.from('YUMAKBK1');
const SALT = 16;
const IV = 12;
const TAG = 16;
const HEAD = BACKUP_MAGIC.length + SALT + IV;
const FORMAT = 'yumakbot-backup';
const VERSION = 1;
export const MIN_BACKUP_PASSWORD = 12;
/** Strong enough to slow guessing, small enough for a phone-sized server. */
const SCRYPT: ScryptOptions = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
/** How long a backup waits on the server to be downloaded. */
const KEEP_MS = 60 * 60 * 1000;
/** The largest record header; anything bigger is a damaged file. */
const MAX_HEADER = 64 * 1024;

/**
 * What goes in besides the database, relative to the data folder. Left out on purpose: the
 * embedded database's own folder (its rows go in as data), the browsers' profiles (large, and
 * signed in to sites on this computer), uploads not yet sent, the access key of this server.
 */
const FOLDERS = ['workspaces', 'pi-sessions'];
const FILES = ['vault.key'];
/** Sign-ins to this server stay with this server; a restore keeps whoever is signed in now. */
const KEEP_TABLES = new Set(['sessions']);

type Header =
  | { type: 'manifest'; format: string; version: number; schema: number; createdAt: string; size: 0 }
  | { type: 'table'; name: string; size: number }
  | { type: 'file'; path: string; size: number; mode: number };

const scrypt = (password: string, salt: Buffer) =>
  new Promise<Buffer>((ok, fail) =>
    scryptCb(password.normalize('NFC'), salt, 32, SCRYPT, (err, key) => (err ? fail(err) : ok(key))),
  );

/** Every table, parents before the tables whose rows point at them. */
export function tablesInOrder(): PgTable[] {
  const tables = (Object.values(schema) as unknown[]).filter((x): x is PgTable => is(x, PgTable));
  const parents = new Map(
    tables.map((t) => [
      t,
      new Set(
        getTableConfig(t)
          .foreignKeys.map((fk) => fk.reference().foreignTable)
          .filter((p) => p !== t),
      ),
    ]),
  );
  const out: PgTable[] = [];
  const placed = new Set<PgTable>();
  while (out.length < tables.length) {
    const next = tables.find((t) => !placed.has(t) && [...parents.get(t)!].every((p) => placed.has(p)));
    if (!next) throw new Error('backup: the tables refer to each other in a circle');
    out.push(next);
    placed.add(next);
  }
  return out;
}

/** Rows read back from JSON as the table takes them: dates were written as text. */
function revive(table: PgTable, rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const dates = Object.entries(getTableColumns(table))
    .filter(([, c]) => c.columnType === 'PgTimestamp')
    .map(([k]) => k);
  if (!dates.length) return rows;
  return rows.map((r) => {
    const o = { ...r };
    for (const k of dates) if (typeof o[k] === 'string') o[k] = new Date(o[k] as string);
    return o;
  });
}

function record(header: Header): Buffer {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(json.length);
  return Buffer.concat([len, json]);
}

/** Files under `dir`, as paths relative to `root`; links are left out, as they may lead anywhere. */
async function* filesUnder(root: string, dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) yield* filesUnder(root, path);
    else if (e.isFile()) yield relative(root, path);
  }
}

/** Reads exact byte counts from a stream of chunks. */
class Reader {
  private buf: Buffer = Buffer.alloc(0);
  private done = false;
  constructor(private it: AsyncIterator<Buffer>) {}

  private async fill(n: number): Promise<boolean> {
    while (this.buf.length < n && !this.done) {
      const r = await this.it.next();
      if (r.done) this.done = true;
      else this.buf = this.buf.length ? Buffer.concat([this.buf, r.value]) : r.value;
    }
    return this.buf.length >= n;
  }

  /** Exactly `n` bytes, or null at a clean end before any of them. */
  async take(n: number): Promise<Buffer | null> {
    if (!(await this.fill(n))) {
      if (!this.buf.length) return null;
      throw new HttpError(400, 'error.backupDamaged');
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  /** `n` bytes handed on in pieces, for a file that may be larger than memory. */
  async *pieces(n: number): AsyncGenerator<Buffer> {
    let left = n;
    while (left > 0) {
      if (!this.buf.length && !(await this.fill(1))) throw new HttpError(400, 'error.backupDamaged');
      const piece = this.buf.subarray(0, Math.min(left, this.buf.length));
      this.buf = this.buf.subarray(piece.length);
      left -= piece.length;
      yield piece;
    }
  }
}

/** A path from inside a backup, kept to where it may go: one of `FOLDERS` or `FILES`. */
function safePath(root: string, rel: string): string | null {
  const parts = rel.split(/[\\/]+/);
  if (parts.some((p) => !p || p === '.' || p === '..')) return null;
  const top = parts[0]!;
  if (!(parts.length > 1 ? FOLDERS.includes(top) : FILES.includes(top))) return null;
  const full = resolve(root, ...parts);
  return full.startsWith(root + sep) ? full : null;
}

export class BackupService {
  constructor(
    private ctx: Ctx,
    /** Starts the server again once a backup is restored: everything it holds in memory is old. */
    private restart: () => void,
  ) {}

  private get dataDir() {
    return resolve(this.ctx.config.dataDir);
  }
  private get dir() {
    return join(this.dataDir, 'backups');
  }

  /** Where a prepared backup waits; null for an id that is not one. */
  path(id: string): string | null {
    if (!/^[\w-]{1,64}$/.test(id)) return null;
    const file = join(this.dir, `${id}.ybk`);
    return existsSync(file) ? file : null;
  }

  /** Writes a sealed backup and returns its id, for one download. */
  async create(password: string): Promise<{ id: string; size: number }> {
    if (password.length < MIN_BACKUP_PASSWORD) throw new HttpError(400, 'error.backupPassword');
    await this.sweep();
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const id = newId();
    const file = join(this.dir, `${id}.ybk`);
    const salt = randomBytes(SALT);
    const iv = randomBytes(IV);
    const cipher = createCipheriv('aes-256-gcm', await scrypt(password, salt), iv);
    // The head goes first and the tag last, once the cipher has finished.
    const framed = new Transform({
      construct(done) {
        this.push(Buffer.concat([BACKUP_MAGIC, salt, iv]));
        done();
      },
      transform: (chunk: Buffer, _e, done) => done(null, chunk),
      flush: (done) => done(null, cipher.getAuthTag()),
    });
    try {
      await pipeline(
        Readable.from(this.records()),
        createGzip(),
        cipher,
        framed,
        createWriteStream(file, { mode: 0o600 }),
      );
    } catch (err) {
      await rm(file, { force: true });
      throw err;
    }
    return { id, size: (await stat(file)).size };
  }

  private async *records(): AsyncGenerator<Buffer> {
    yield record({
      type: 'manifest',
      format: FORMAT,
      version: VERSION,
      schema: schemaVersion(),
      createdAt: new Date().toISOString(),
      size: 0,
    });
    for (const table of tablesInOrder()) {
      const name = getTableName(table);
      if (KEEP_TABLES.has(name)) continue;
      const rows = await this.ctx.db.select().from(table);
      const data = Buffer.from(JSON.stringify(rows), 'utf8');
      yield record({ type: 'table', name, size: data.length });
      yield data;
    }
    const root = this.dataDir;
    const paths = FILES.filter((f) => existsSync(join(root, f)));
    for (const f of FOLDERS) for await (const path of filesUnder(root, join(root, f))) paths.push(path);
    for (const path of paths) {
      const full = join(root, path);
      let info;
      try {
        info = await lstat(full);
      } catch {
        continue; // gone since it was listed
      }
      if (!info.isFile()) continue;
      yield record({
        type: 'file',
        path: path.split(sep).join('/'),
        size: info.size,
        mode: info.mode & 0o777,
      });
      // Exactly the size announced, even when the file changes while it is read.
      let sent = 0;
      if (info.size > 0) {
        for await (const chunk of createReadStream(full, { start: 0, end: info.size - 1 })) {
          const piece = chunk as Buffer;
          sent += piece.length;
          yield piece;
        }
      }
      if (sent < info.size) yield Buffer.alloc(info.size - sent);
    }
  }

  /** Removes prepared backups nobody downloaded. */
  async sweep(now = Date.now()) {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    for (const n of names) {
      const file = join(this.dir, n);
      const info = await stat(file).catch(() => null);
      if (info && now - info.mtimeMs > KEEP_MS) await rm(file, { recursive: true, force: true });
    }
  }

  /**
   * Replaces everything with what a backup holds. The upload is checked whole first (password and
   * tag), then unpacked beside the data; only then are the database's rows swapped in one
   * transaction and the folders moved into place. Until that point a wrong password, a damaged
   * file or a backup from a newer version changes nothing. The folders it replaces are kept
   * beside the new ones (`*.before-restore`) until the next restore. The server starts again after.
   */
  async restore(upload: Readable, password: string): Promise<{ tables: number; files: number }> {
    if (!password) throw new HttpError(400, 'error.backupWrongPassword');
    await this.ensureIdle();
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const work = join(this.dir, `restore-${newId()}`);
    await mkdir(work, { recursive: true, mode: 0o700 });
    try {
      const sealed = join(work, 'upload.ybk');
      await pipeline(upload, createWriteStream(sealed, { mode: 0o600 }));
      const { key, iv, end, tag } = await this.unseal(sealed, password);
      // First pass: the tag proves the password and that nothing was changed, before anything is used.
      await this.decrypt(sealed, key, iv, end, tag, new Writable({ write: (_c, _e, done) => done() }));
      // Second pass: unpack beside the data.
      const staged = join(work, 'data');
      const tables = new Map<string, string>();
      let files = 0;
      const plain = new PassThrough();
      const reading = this.decrypt(sealed, key, iv, end, tag, plain);
      // Read below; a failure there must not leave this pass waiting on a reader that stopped.
      reading.catch(() => {});
      const gunzip = createGunzip();
      plain.pipe(gunzip);
      plain.on('error', (err) => gunzip.destroy(err));
      const reader = new Reader(gunzip[Symbol.asyncIterator]());
      let manifest = false;
      try {
        for (;;) {
          const len = await reader.take(4);
          if (!len) break;
          const size = len.readUInt32BE();
          if (size > MAX_HEADER) throw new HttpError(400, 'error.backupDamaged');
          const raw = await reader.take(size);
          let header: Header;
          try {
            header = JSON.parse(raw!.toString('utf8')) as Header;
          } catch {
            throw new HttpError(400, 'error.backupDamaged');
          }
          if (!manifest) {
            if (header.type !== 'manifest' || header.format !== FORMAT || header.version !== VERSION) {
              throw new HttpError(400, 'error.backupDamaged');
            }
            // A newer version may have tables and columns this one does not know.
            if (header.schema > schemaVersion()) throw new HttpError(400, 'error.backupNewer');
            manifest = true;
            continue;
          }
          if (header.type === 'table') {
            const file = join(work, 'tables', `${tables.size}.json`);
            await mkdir(dirname(file), { recursive: true });
            await pipeline(Readable.from(reader.pieces(header.size)), createWriteStream(file));
            tables.set(header.name, file);
          } else if (header.type === 'file') {
            const target = safePath(staged, header.path);
            if (!target) {
              // Not a place a backup may write to: skip its bytes.
              for await (const piece of reader.pieces(header.size)) void piece;
              continue;
            }
            await mkdir(dirname(target), { recursive: true, mode: 0o700 });
            await pipeline(
              Readable.from(reader.pieces(header.size)),
              createWriteStream(target, { mode: header.mode & 0o700 || 0o600 }),
            );
            files++;
          } else {
            throw new HttpError(400, 'error.backupDamaged');
          }
        }
      } catch (err) {
        plain.destroy();
        gunzip.destroy();
        throw err;
      }
      await reading;
      if (!manifest) throw new HttpError(400, 'error.backupDamaged');
      await this.ensureIdle();
      await this.replaceRows(tables);
      await this.moveInto(staged);
      setTimeout(() => this.restart(), 300).unref();
      return { tables: tables.size, files };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  /** A restore while a bot works would cut its turn off halfway; the person waits for it first. */
  private async ensureIdle() {
    const [busy] = await this.ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.turns)
      .where(inArray(schema.turns.status, ['queued', 'running']));
    if (busy && busy.n > 0) throw new HttpError(409, 'error.backupBusy');
  }

  private async unseal(file: string, password: string) {
    const fd = await open(file, 'r');
    try {
      const { size } = await fd.stat();
      if (size < HEAD + TAG) throw new HttpError(400, 'error.backupDamaged');
      const head = Buffer.alloc(HEAD);
      await fd.read(head, 0, HEAD, 0);
      if (!head.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC))
        throw new HttpError(400, 'error.backupDamaged');
      const tag = Buffer.alloc(TAG);
      await fd.read(tag, 0, TAG, size - TAG);
      const salt = head.subarray(BACKUP_MAGIC.length, BACKUP_MAGIC.length + SALT);
      const iv = head.subarray(BACKUP_MAGIC.length + SALT);
      return { key: await scrypt(password, salt), iv, end: size - TAG - 1, tag };
    } finally {
      await fd.close();
    }
  }

  private async decrypt(file: string, key: Buffer, iv: Buffer, end: number, tag: Buffer, to: Writable) {
    const d = createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    try {
      await pipeline(createReadStream(file, { start: HEAD, end }), d as Transform, to);
    } catch (err) {
      // GCM's check fails at the end: a wrong password and a changed file look the same.
      if (err instanceof HttpError) throw err;
      if (/auth|decrypt/i.test(String(err))) throw new HttpError(400, 'error.backupWrongPassword');
      throw err;
    }
  }

  /** Every table's rows, all or nothing. */
  private async replaceRows(files: Map<string, string>) {
    const order = tablesInOrder().filter((t) => !KEEP_TABLES.has(getTableName(t)));
    const rows = new Map<PgTable, Record<string, unknown>[]>();
    for (const table of order) {
      const file = files.get(getTableName(table));
      rows.set(
        table,
        file ? revive(table, JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>[]) : [],
      );
    }
    await this.ctx.db.transaction(async (tx) => {
      for (const table of [...order].reverse()) await tx.delete(table);
      for (const table of order) {
        const list = rows.get(table)!;
        for (let i = 0; i < list.length; i += 200) await tx.insert(table).values(list.slice(i, i + 200));
      }
    });
  }

  /**
   * Moves the unpacked folders and files into the data folder. What they replace is kept as
   * `<name>.before-restore`, so a restore that brought the wrong file can still be undone by hand.
   * A folder keeps its own place and only its contents move: the computer service mounts
   * `workspaces` itself, and a renamed folder would stay mounted there.
   */
  private async moveInto(staged: string) {
    const root = this.dataDir;
    for (const name of FOLDERS) {
      const to = join(root, name);
      const kept = `${to}.before-restore`;
      await rm(kept, { recursive: true, force: true });
      await mkdir(kept, { recursive: true, mode: 0o700 });
      await mkdir(to, { recursive: true, mode: 0o700 });
      for (const child of await readdir(to)) await rename(join(to, child), join(kept, child));
      const from = join(staged, name);
      if (existsSync(from))
        for (const child of await readdir(from)) await rename(join(from, child), join(to, child));
    }
    for (const name of FILES) {
      const from = join(staged, name);
      if (!existsSync(from)) continue;
      const to = join(root, name);
      const kept = `${to}.before-restore`;
      await rm(kept, { force: true });
      if (existsSync(to)) await rename(to, kept);
      await rename(from, to);
    }
  }
}
