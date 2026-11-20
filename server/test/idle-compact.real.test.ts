import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bot, Message, Thread } from '@yumakbot/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type YumakBotServer } from '../src/app';
import { loadConfig } from '../src/config';
import { schema } from '../src/db';
import { KEY } from './helpers';

/**
 * Folds a real Claude session while idle. Off by default:
 *   YUMAKBOT_REAL_CLAUDE=1 pnpm vitest run --project server test/idle-compact.real
 */
const enabled = process.env.YUMAKBOT_REAL_CLAUDE === '1';

describe.skipIf(!enabled)('gerçek Claude: boştaki sohbeti özetleme', () => {
  let s: YumakBotServer;
  let dataDir: string;
  const api = async <T>(method: string, url: string, body?: unknown) => {
    const res = await s.app.inject({
      method: method as 'GET',
      url,
      headers: { authorization: `Bearer ${KEY}`, host: 'localhost' },
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    return res.json() as T;
  };
  const send = (threadId: string, text: string) =>
    api<Message>('POST', `/api/threads/${threadId}/messages`, {
      clientId: `c-${Date.now()}-${Math.random()}`,
      text,
    });
  const messages = (threadId: string) => api<Message[]>('GET', `/api/threads/${threadId}/messages`);

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'yumakbot-real-'));
    s = await createServer(
      loadConfig(
        {},
        {
          dataDir,
          memoryDb: true,
          databaseUrl: null,
          accessKey: KEY,
          engine: 'claude',
          claudeModel: process.env.YUMAKBOT_CLAUDE_MODEL ?? 'haiku',
          routinesEnabled: false,
          appDir: null,
        },
      ),
    );
  }, 60_000);
  afterAll(async () => {
    await s?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('oturumu özetler, doluluğunu ve maliyetini yazar; bot sonra da hatırlar', async () => {
    const bot = await api<Bot>('POST', '/api/bots', { name: 'Özetçi', permissionMode: 'ask' });
    const thread = await api<Thread>('GET', `/api/bots/${bot.id}/main-thread`);
    await send(thread.id, 'Gizli kelimemiz "zeytin". Sadece "tamam" yaz.');
    await s.services.turns.idle(120_000);

    const before = await s.services.threads.row(thread.id);
    expect(before.engineSessionId).toBeTruthy();
    // The run reports how full the session is.
    expect(before.engineSessionTokens).toBeGreaterThan(1000);

    expect(await s.services.turns.foldIdle(thread.id)).toBe('folded');
    const after = await s.services.threads.row(thread.id);
    expect(after.engineSessionId).toBeTruthy();
    if (after.engineSessionTokens !== null) {
      expect(after.engineSessionTokens).toBeLessThan(before.engineSessionTokens!);
    }
    const [upkeep] = await s.db.db
      .select()
      .from(schema.turns)
      .where(and(eq(schema.turns.threadId, thread.id), eq(schema.turns.source, 'upkeep')));
    expect(upkeep).toMatchObject({ status: 'done' });
    expect(upkeep!.costUsd).toBeGreaterThan(0);
    expect((await messages(thread.id)).some((m) => m.props.kind === 'compacted')).toBe(true);

    await send(thread.id, 'Gizli kelimemiz neydi? Sadece o kelimeyi yaz.');
    await s.services.turns.idle(120_000);
    const answer = (await messages(thread.id)).filter((m) => m.role === 'assistant').at(-1)!;
    expect(answer.text.toLowerCase()).toContain('zeytin');
  }, 300_000);
});
