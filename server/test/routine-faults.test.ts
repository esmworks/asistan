import type { Routine, RoutineRun } from '@yumakbot/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '../src/db';
import { MAX_ROUTINES_PER_BOT } from '../src/services/routines';
import { newId } from '../src/util';
import { testServer, type TestServer } from './helpers';

describe('rutin aksaklıkları', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const make = async (botId: string, name: string, extra: Record<string, unknown> = {}) =>
    (
      await t.api<Routine>('POST', '/api/routines', {
        botId,
        name,
        prompt: `${name} işini yap`,
        schedule: { type: 'interval', minutes: 30 },
        ...extra,
      })
    ).body;
  const runs = async (id: string) => (await t.api<RoutineRun[]>('GET', `/api/routines/${id}/runs`)).body;
  const routine = async (id: string) =>
    (await t.api<Routine[]>('GET', '/api/routines')).body.find((x) => x.id === id)!;

  it('başlatılamayan rutin hatalı çalıştırma olarak yazılır, sırası ilerler; öbür rutinler yine çalışır', async () => {
    const bot = await t.bot();
    const broken = await make(bot.id, 'Bozuk');
    const fine = await make(bot.id, 'Sağlam');
    const threads = t.services.threads;
    const real = threads.routineThread.bind(threads);
    vi.spyOn(threads, 'routineThread').mockImplementation(async (botId, name, ...rest) => {
      if (name === 'Bozuk') throw new Error('disk dolu');
      return real(botId, name, ...rest);
    });
    t.now.value = new Date(t.now.value.getTime() + 31 * 60_000);
    await t.services.routines.tick();
    await t.services.turns.idle();
    const [failed] = await runs(broken.id);
    expect(failed!.status).toBe('error');
    expect(failed!.reason).toContain('disk dolu');
    expect((await runs(fine.id)).map((r) => r.status)).toEqual(['done']);
    // Its slot passed: it is not tried again on every pass until the fault goes away.
    expect(Date.parse((await routine(broken.id)).nextRunAt!)).toBeGreaterThan(t.now.value.getTime());
  });

  it('turu kuyruğa giremeyen çalıştırma hemen hatayla kapanır, sonrakini engellemez', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, 'Rapor');
    vi.spyOn(t.services.turns, 'enqueue').mockRejectedValueOnce(new Error('kuyruk kapalı'));
    const started = await t.api<RoutineRun>('POST', `/api/routines/${r.id}/run`);
    expect(started.body.status).toBe('error');
    const [first] = await runs(r.id);
    expect(first!.status).toBe('error');
    expect(first!.reason).toContain('kuyruk kapalı');
    t.now.value = new Date(t.now.value.getTime() + 1000);
    await t.api('POST', `/api/routines/${r.id}/run`);
    await t.services.turns.idle();
    expect((await runs(r.id)).map((x) => x.status)).toEqual(['done', 'error']);
  });

  it('süren çalıştırmanın arkasında atlanan çalıştırmalar tek satırda sayılır', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, 'Uzun', { prompt: '[bekle:3000]' });
    await t.api('POST', `/api/routines/${r.id}/run`);
    for (let i = 1; i <= 3; i++) {
      t.now.value = new Date(t.now.value.getTime() + 1000);
      await t.api('POST', `/api/routines/${r.id}/run`);
    }
    const list = await runs(r.id);
    expect(list.map((x) => x.status)).toEqual(['skipped', 'running']);
    expect(list[0]!.reason).toContain('3');
    await t.api('POST', `/api/threads/${list[1]!.threadId}/stop`);
    await t.services.turns.idle();
    // A run started after the stuck one ended starts a new line when it is held up in turn.
    t.now.value = new Date(t.now.value.getTime() + 1000);
    await t.api('POST', `/api/routines/${r.id}/run`);
    t.now.value = new Date(t.now.value.getTime() + 1000);
    await t.api('POST', `/api/routines/${r.id}/run`);
    const after = await runs(r.id);
    expect(after.filter((x) => x.status === 'skipped')).toHaveLength(2);
    await t.api('POST', `/api/threads/${after.find((x) => x.status === 'running')!.threadId}/stop`);
    await t.services.turns.idle();
  });

  it('dakikada bir çalışacak cron ifadesi reddedilir, beş dakikalık kabul edilir', async () => {
    const bot = await t.bot();
    const often = await t.api<{ error: string }>('POST', '/api/routines', {
      botId: bot.id,
      name: 'Sık',
      prompt: 'x',
      schedule: { type: 'cron', expr: '* * * * *' },
    });
    expect(often.status).toBe(400);
    expect(often.body.error).toContain('5 dakika');
    const ok = await make(bot.id, 'Seyrek', { schedule: { type: 'cron', expr: '*/5 * * * *' } });
    expect(ok.id).toBeTruthy();
    const patched = await t.api('PATCH', `/api/routines/${ok.id}`, {
      schedule: { type: 'cron', expr: '*/2 9 * * *' },
    });
    expect(patched.status).toBe(400);
    // One that came in another way, paused, is not turned on with it.
    await t.db.db.insert(schema.routines).values({
      id: 'eski',
      botId: bot.id,
      name: 'Eski',
      prompt: 'x',
      schedule: { type: 'cron', expr: '* * * * *' },
      timezone: 'UTC',
      enabled: false,
    });
    expect((await t.api('PATCH', '/api/routines/eski', { enabled: true })).status).toBe(400);
  });

  it('bir botun rutin sayısı sınırlıdır', async () => {
    const bot = await t.bot();
    await t.db.db.insert(schema.routines).values(
      Array.from({ length: MAX_ROUTINES_PER_BOT }, (_, i) => ({
        id: newId(),
        botId: bot.id,
        name: `Rutin ${i}`,
        prompt: 'x',
        schedule: { type: 'interval', minutes: 30 },
        timezone: 'UTC',
      })),
    );
    const over = await t.api<{ error: string }>('POST', '/api/routines', {
      botId: bot.id,
      name: 'Fazla',
      prompt: 'x',
      schedule: { type: 'interval', minutes: 30 },
    });
    expect(over.status).toBe(400);
    expect(over.body.error).toContain(String(MAX_ROUTINES_PER_BOT));
    const other = await t.bot({ name: 'Ayşe' });
    expect((await make(other.id, 'Başka')).id).toBeTruthy();
  });

  it('geçici hatadan sonraki yeniden deneme aralıklı rutinin ritmini kaydırmaz', async () => {
    const bot = await t.bot();
    // The clock stands at 05:00 UTC: the first slot is 06:00, then every hour on the hour.
    const r = await make(bot.id, 'Saatlik', {
      prompt: '[meşgul]',
      schedule: { type: 'interval', minutes: 60 },
    });
    expect(r.nextRunAt).toBe('2026-11-16T06:00:00.000Z');
    t.now.value = new Date('2026-11-16T06:00:30.000Z');
    await t.services.routines.tick();
    await t.services.turns.idle();
    // It failed for a passing reason: tried again five minutes later.
    expect((await routine(r.id)).nextRunAt).toBe('2026-11-16T06:05:30.000Z');
    t.now.value = new Date('2026-11-16T06:06:00.000Z');
    await t.services.routines.tick();
    await t.services.turns.idle();
    expect((await runs(r.id)).map((x) => x.status)).toEqual(['error', 'error']);
    // After the retry it goes on from its own slot, not an hour after the retry.
    expect((await routine(r.id)).nextRunAt).toBe('2026-11-16T07:00:00.000Z');
  });
});
