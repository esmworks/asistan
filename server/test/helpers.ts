import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bot, BotCreate, Message } from '@yumakbot/shared';
import { createServer, type YumakBotServer } from '../src/app';
import { loadConfig, type Config } from '../src/config';
import { FakeEngine } from '../src/engine/fake';
import postgres from 'postgres';

/** Set to run the suite on PostgreSQL instead of in-memory PGlite; each server gets its own database. */
const PG_URL = process.env.YUMAKBOT_TEST_DATABASE_URL;

async function freshDatabase(): Promise<{ url: string; drop(): Promise<void> } | null> {
  if (!PG_URL) return null;
  const name = `yumakbot_t_${Math.random().toString(36).slice(2, 10)}`;
  const admin = postgres(PG_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name}`);
  await admin.end();
  const url = new URL(PG_URL);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    async drop() {
      const a = postgres(PG_URL, { max: 1, onnotice: () => {} });
      await a.unsafe(`drop database if exists ${name} with (force)`);
      await a.end();
    },
  };
}

export const KEY = 'test-access-key-123';
export const AUTH = { authorization: `Bearer ${KEY}` };

export interface TestServer extends YumakBotServer {
  engine: FakeEngine;
  dataDir: string;
  now: { value: Date };
  api<T = unknown>(method: string, url: string, body?: unknown): Promise<{ status: number; body: T }>;
  bot(input?: Partial<BotCreate>): Promise<Bot>;
  send(threadId: string, text: string): Promise<Message>;
  messages(threadId: string): Promise<Message[]>;
  dispose(): Promise<void>;
}

export async function testServer(overrides: Partial<Config> = {}): Promise<TestServer> {
  const dataDir = mkdtempSync(join(tmpdir(), 'yumakbot-test-'));
  const pg = await freshDatabase();
  const config = loadConfig(
    {},
    {
      dataDir,
      memoryDb: !pg,
      databaseUrl: pg?.url ?? null,
      accessKey: KEY,
      engine: 'fake',
      routinesEnabled: false,
      reactionDelayMs: 10,
      browserPath: null,
      appDir: null,
      port: 0,
      ...overrides,
    },
  );
  const engine = new FakeEngine();
  const now = { value: new Date('2026-11-16T05:00:00.000Z') };
  const server = await createServer(config, { engine, clock: () => now.value });
  const api = async <T>(method: string, url: string, body?: unknown) => {
    const res = await server.app.inject({
      method: method as 'GET',
      url,
      headers: { ...AUTH, host: 'localhost' },
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    return { status: res.statusCode, body: (res.body ? res.json() : null) as T };
  };
  let n = 0;
  const t: TestServer = {
    ...server,
    engine,
    dataDir,
    now,
    api,
    async bot(input = {}) {
      const r = await api<Bot>('POST', '/api/bots', { name: `Bot ${++n}`, ...input });
      if (r.status !== 200) throw new Error(JSON.stringify(r.body));
      return r.body;
    },
    async send(threadId, text) {
      const r = await api<Message>('POST', `/api/threads/${threadId}/messages`, {
        clientId: `c-${Math.random().toString(36).slice(2, 12)}`,
        text,
      });
      if (r.status >= 300) throw new Error(JSON.stringify(r.body));
      return r.body;
    },
    async messages(threadId) {
      return (await api<Message[]>('GET', `/api/threads/${threadId}/messages`)).body;
    },
    async dispose() {
      await server.close();
      await pg?.drop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
  return t;
}

export async function waitFor<T>(
  fn: () => Promise<T | undefined | null | false>,
  timeoutMs = 10_000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor zaman aşımı');
    await new Promise((r) => setTimeout(r, 20));
  }
}
