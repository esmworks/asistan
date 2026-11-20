import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DoctorReport, Thread } from '@leafbot/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { newId } from '../src/util';
import { testServer, waitFor, type TestServer } from './helpers';

describe('sunucu bakımı (doctor)', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const check = async () => (await t.api<DoctorReport>('GET', '/api/doctor')).body;
  const found = (r: DoctorReport, id: string) => r.checks.find((c) => c.id === id)!;
  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const longAgo = () => new Date(Date.now() - 10 * 60_000);

  it('temiz sunucuda her şey yolunda; yalnız yönetici denetler', async () => {
    const r = await check();
    for (const id of ['stuckTurns', 'staleApprovals', 'strayFolders', 'unreadable']) {
      expect(found(r, id)).toMatchObject({ status: 'ok', count: 0 });
    }
    const member = await t.person('uye', 'member');
    expect((await member.api('GET', '/api/doctor')).status).toBe(403);
    expect((await member.api('POST', '/api/doctor/repair', { checks: ['strayFolders'] })).status).toBe(403);
  });

  it('çalışmayan ama sürüyor görünen işi bulur ve durdurulmuş sayar; kartı da süresi dolmuş sayar', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    const turnId = newId();
    await t.db.db.insert(schema.turns).values({
      id: turnId,
      threadId: thread.id,
      botId: bot.id,
      status: 'running',
      source: 'user',
      prompt: 'iş',
      startedAt: longAgo(),
    });
    const approvalId = newId();
    await t.db.db.insert(schema.approvals).values({
      id: approvalId,
      threadId: thread.id,
      botId: bot.id,
      turnId,
      kind: 'tool',
      toolName: 'Bash',
      input: {},
      summary: 'x',
      status: 'pending',
      createdAt: longAgo(),
    });
    const before = await check();
    expect(found(before, 'stuckTurns')).toMatchObject({ status: 'warn', count: 1 });
    expect(found(before, 'staleApprovals')).toMatchObject({ status: 'warn', count: 1 });

    const after = (
      await t.api<DoctorReport>('POST', '/api/doctor/repair', { checks: ['stuckTurns', 'staleApprovals'] })
    ).body;
    expect(found(after, 'stuckTurns').count).toBe(0);
    expect(found(after, 'staleApprovals').count).toBe(0);
    const [turn] = await t.db.db.select().from(schema.turns).where(eq(schema.turns.id, turnId));
    expect(turn!.status).toBe('interrupted');
    const [card] = await t.db.db.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId));
    expect(card!.status).toBe('expired');
    expect((await t.messages(thread.id)).some((m) => m.role === 'system')).toBe(true);
  });

  it('şu an çalışan işe dokunmaz', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, '[bekle:3000] uzun iş');
    await waitFor(async () => t.engine.requests.length > 0);
    // As if it had run for long: the grace alone does not keep it.
    await t.db.db
      .update(schema.turns)
      .set({ startedAt: longAgo() })
      .where(eq(schema.turns.threadId, thread.id));
    expect(found(await check(), 'stuckTurns').count).toBe(0);
    await t.api('POST', '/api/doctor/repair', { checks: ['stuckTurns'] });
    await t.services.turns.idle(5000);
    const [turn] = await t.db.db.select().from(schema.turns).where(eq(schema.turns.threadId, thread.id));
    expect(turn!.status).toBe('done');
  });

  it('silinmiş bot ve sohbetin klasörlerini silmeden kenara taşır; yaşayanlara dokunmaz', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    const root = join(t.dataDir, 'workspaces', 'bots');
    const live = join(root, bot.id, 'threads', thread.id);
    mkdirSync(live, { recursive: true });
    writeFileSync(join(live, 'not.txt'), 'kalsın');
    const goneBot = join(root, 'silinmis-bot', 'files');
    mkdirSync(goneBot, { recursive: true });
    writeFileSync(join(goneBot, 'rapor.txt'), 'eski rapor');
    const goneThread = join(root, bot.id, 'threads', 'silinmis-sohbet');
    mkdirSync(goneThread, { recursive: true });
    writeFileSync(join(goneThread, 'a.txt'), 'abc');

    // Just made: still in someone's hands, so not counted yet.
    expect(found(await check(), 'strayFolders').count).toBe(0);
    const old = longAgo();
    for (const dir of [join(root, 'silinmis-bot'), goneThread]) utimesSync(dir, old, old);
    const r = await check();
    expect(found(r, 'strayFolders')).toMatchObject({ status: 'warn', count: 2 });
    expect(found(r, 'strayFolders').bytes).toBe('eski rapor'.length + 3);

    const after = (await t.api<DoctorReport>('POST', '/api/doctor/repair', { checks: ['strayFolders'] }))
      .body;
    expect(found(after, 'strayFolders').count).toBe(0);
    expect(after.movedTo).toContain('doctor-trash');
    expect(existsSync(join(root, 'silinmis-bot'))).toBe(false);
    expect(
      readFileSync(join(after.movedTo!, 'workspaces', 'bots', 'silinmis-bot', 'files', 'rapor.txt'), 'utf8'),
    ).toBe('eski rapor');
    expect(
      existsSync(join(after.movedTo!, 'workspaces', 'bots', bot.id, 'threads', 'silinmis-sohbet', 'a.txt')),
    ).toBe(true);
    expect(readFileSync(join(live, 'not.txt'), 'utf8')).toBe('kalsın');
  });

  it('disk alanını bildirir', async () => {
    const disk = found(await check(), 'disk');
    expect(disk.repairable).toBe(false);
    expect(disk.bytes).toBeGreaterThan(0);
  });
});
