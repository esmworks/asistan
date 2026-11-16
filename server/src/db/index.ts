import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export { schema };

export interface DbHandle {
  db: Db;
  kind: 'pglite' | 'postgres';
  close(): Promise<void>;
}

// Source runs from src/db, the bundle from dist; migrations sit next to either.
const migrationsFolder =
  [
    process.env.YUMAKBOT_MIGRATIONS_DIR,
    resolve(import.meta.dirname, 'drizzle'),
    resolve(import.meta.dirname, '../../drizzle'),
  ].find((p): p is string => !!p && existsSync(resolve(p, 'meta/_journal.json'))) ??
  resolve(import.meta.dirname, '../../drizzle');

/** How many migrations the database has been through: a backup records it, a restore compares. */
export function schemaVersion(): number {
  const journal = JSON.parse(readFileSync(resolve(migrationsFolder, 'meta/_journal.json'), 'utf8')) as {
    entries: unknown[];
  };
  return journal.entries.length;
}

export async function openDb(opts: {
  url: string | null;
  dataDir: string;
  memory: boolean;
}): Promise<DbHandle> {
  if (opts.url) {
    const { default: postgres } = await import('postgres');
    const { drizzle } = await import('drizzle-orm/postgres-js');
    const { migrate } = await import('drizzle-orm/postgres-js/migrator');
    const client = postgres(opts.url, { max: 10, onnotice: () => {} });
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder });
    return { db: db as unknown as Db, kind: 'postgres', close: () => client.end() };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate } = await import('drizzle-orm/pglite/migrator');
  let client;
  if (opts.memory) {
    client = new PGlite();
  } else {
    const dir = join(opts.dataDir, 'db');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    client = new PGlite(dir);
  }
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  return { db: db as unknown as Db, kind: 'pglite', close: () => client.close() };
}
