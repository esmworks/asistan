import type { Routine, RoutineRun, UsageReport } from '@yumakbot/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '../src/db';
import { pageDiff } from '../src/services/routines';
import type * as SkillLink from '../src/services/skill-link';
import { testServer, type TestServer } from './helpers';

const page = vi.hoisted(() => ({ html: '' }));
vi.mock('../src/services/skill-link', async (original) => ({
  ...(await original<typeof SkillLink>()),
  fetchPublicText: async () => page.html,
}));

describe('rutin ön kontrolü', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const runs = async (id: string) => (await t.api<RoutineRun[]>('GET', `/api/routines/${id}/runs`)).body;
  const settle = async () => {
    await t.services.routines.settled();
    await t.services.turns.idle();
  };

  /** A routine with a webhook address, and a call to it carrying `payload`. */
  async function hooked(prompt = 'Yeni sipariş gelirse özetle') {
    const bot = await t.bot();
    const r = (
      await t.api<Routine>('POST', '/api/routines', {
        botId: bot.id,
        name: 'Siparişler',
        prompt,
        schedule: { type: 'interval', minutes: 60 },
        enabled: false,
      })
    ).body;
    const { webhookToken } = (await t.api<Routine>('POST', `/api/routines/${r.id}/webhook`)).body;
    const call = (payload?: object) => {
      // A call without a delivery id is told apart from the one before by its time.
      t.now.value = new Date(t.now.value.getTime() + 60_000);
      return t.app.inject({
        method: 'POST',
        url: `/api/hooks/routines/${r.id}/${webhookToken}`,
        headers: { host: 'localhost' },
        payload,
      });
    };
    // The webhook runs a routine only while it is on; its schedule is not what is tested here.
    await t.api('PATCH', `/api/routines/${r.id}`, { enabled: true });
    return { r, call };
  }

  it('kapalıyken küçük modele sormaz', async () => {
    const { r, call } = await hooked();
    await call({ note: 'önemsiz' });
    await settle();
    expect(t.engine.gates).toHaveLength(0);
    expect((await runs(r.id))[0]).toMatchObject({ status: 'done', gate: null });
  });

  it('yalnızca izlerken her çalışma yapılır; atlanabilecek olan yanında yazılır ve kullanımda sayılır', async () => {
    await t.api('PATCH', '/api/settings', { routineGate: 'shadow' });
    const { r, call } = await hooked();
    const before = t.engine.requests.length;
    await call({ note: 'önemsiz' });
    await settle();
    await call({ note: 'yeni sipariş' });
    await settle();
    expect(t.engine.requests.length - before).toBe(2);
    expect(t.engine.gates.map((g) => g.trigger)).toEqual(['webhook', 'webhook']);
    expect(t.engine.gates[0]!.routine.prompt).toBe('Yeni sipariş gelirse özetle');
    const [second, first] = await runs(r.id);
    expect(first).toMatchObject({ status: 'done', gate: { decision: 'skip' } });
    expect(second).toMatchObject({ status: 'done', gate: { decision: 'run' } });

    await t.db.db.update(schema.turns).set({ costUsd: 0.3 }).where(eq(schema.turns.routineRunId, first!.id));
    const report = (await t.api<UsageReport>('GET', '/api/usage?days=7')).body;
    expect(report.gate).toEqual({
      checks: 2,
      costUsd: 0.002,
      skippable: 1,
      skippableCostUsd: 0.3,
      skipped: 0,
    });
  });

  it('açıkken yeni bir şey olmayan çalışma bot başlamadan gerekçesiyle atlanır', async () => {
    await t.api('PATCH', '/api/settings', { routineGate: 'on' });
    const { r, call } = await hooked();
    const before = t.engine.requests.length;
    const res = await call({ note: 'önemsiz' });
    // The caller hears back at once; the check goes on after the answer.
    expect(res.json()).toMatchObject({ status: 'running' });
    await settle();
    expect(t.engine.requests.length).toBe(before);
    const [run] = await runs(r.id);
    expect(run).toMatchObject({ status: 'skipped', gate: { decision: 'skip' } });
    expect(run!.reason).toContain('Sahte ön kontrol: yeni bir şey yok.');
    expect(run!.threadId).not.toBeNull();
    expect(await t.messages(run!.threadId!)).toHaveLength(0);
    const report = (await t.api<UsageReport>('GET', '/api/usage?days=7')).body;
    expect(report.gate).toMatchObject({ checks: 1, skippable: 0, skipped: 1 });
  });

  it('açıkken bakmaya değer çalışma da kontrol hata verince çalışma da yapılır', async () => {
    await t.api('PATCH', '/api/settings', { routineGate: 'on' });
    const { r, call } = await hooked();
    await call({ note: 'yeni sipariş' });
    await settle();
    await call({ note: 'kapı-hatası' });
    await settle();
    const [failed, ran] = await runs(r.id);
    expect(ran).toMatchObject({ status: 'done', gate: { decision: 'run' } });
    expect(failed).toMatchObject({ status: 'done', gate: null });
  });

  it('boş webhook çağrısı ve elle çalıştırma kontrol edilmez', async () => {
    await t.api('PATCH', '/api/settings', { routineGate: 'on' });
    const { r, call } = await hooked();
    await call();
    await settle();
    t.now.value = new Date(t.now.value.getTime() + 60_000);
    await t.services.routines.runNow(r.id, 'önemsiz');
    await settle();
    expect(t.engine.gates).toHaveLength(0);
    expect((await runs(r.id)).map((x) => x.status)).toEqual(['done', 'done']);
  });

  it('izlenen sayfada küçük model sayfanın tamamını değil değişeni okur', async () => {
    await t.api('PATCH', '/api/settings', { routineGate: 'on' });
    const bot = await t.bot();
    const r = (
      await t.api<Routine>('POST', '/api/routines', {
        botId: bot.id,
        name: 'Fiyat',
        prompt: 'Fiyat düşerse haber ver',
        schedule: { type: 'interval', minutes: 30 },
        watchUrl: 'https://ornek.com/urun',
      })
    ).body;
    const tick = async () => {
      t.now.value = new Date(t.now.value.getTime() + 31 * 60_000);
      await t.services.routines.tick();
      await settle();
    };
    page.html = '<p>Masa. Fiyat 100 TL. Görüntülenme 5.</p>';
    await tick();
    page.html = '<p>Masa. Fiyat 100 TL. Görüntülenme 6 önemsiz.</p>';
    await tick();
    expect(t.engine.gates).toHaveLength(1);
    expect(t.engine.gates[0]).toMatchObject({ trigger: 'watch' });
    expect(t.engine.gates[0]!.input).toContain('- Görüntülenme 5.');
    expect(t.engine.gates[0]!.input).not.toContain('Fiyat 100');
    expect((await runs(r.id))[0]).toMatchObject({ status: 'skipped' });
  });

  it('sayfa farkı çıkan ve giren cümleleri listeler', () => {
    expect(pageDiff('A geldi. B kaldı.', 'A geldi. C eklendi.')).toBe(
      'Removed:\n- B kaldı.\n\nAdded:\n- C eklendi.',
    );
    expect(pageDiff('A. B.', 'A.  B.')).toBeNull();
  });
});
