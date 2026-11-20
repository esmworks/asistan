import type { Routine, RoutineRevision } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { testServer, type TestServer } from './helpers';

describe('rutin talimat geçmişi', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const make = async () => {
    const bot = await t.bot();
    return (
      await t.api<Routine>('POST', '/api/routines', {
        botId: bot.id,
        name: 'Rapor',
        prompt: 'Haftalık raporu yaz',
        schedule: { type: 'interval', minutes: 60 },
      })
    ).body;
  };
  const history = async (id: string) =>
    (await t.api<RoutineRevision[]>('GET', `/api/routines/${id}/revisions`)).body.map((r) => r.prompt);
  const later = () => {
    t.now.value = new Date(t.now.value.getTime() + 60_000);
  };

  it('her talimat değişikliği yeni sürüm olur, en yenisi başta', async () => {
    const r = await make();
    expect(await history(r.id)).toEqual(['Haftalık raporu yaz']);
    later();
    await t.api('PATCH', `/api/routines/${r.id}`, { prompt: 'Günlük raporu yaz' });
    // Talimat dışı bir değişiklik geçmişe yazılmaz.
    later();
    await t.api('PATCH', `/api/routines/${r.id}`, { name: 'Günlük rapor' });
    expect(await history(r.id)).toEqual(['Günlük raporu yaz', 'Haftalık raporu yaz']);
  });

  it('eski sürüme dönmek onu yeniden en yeni yapar; geçmiş silinmez', async () => {
    const r = await make();
    later();
    await t.api('PATCH', `/api/routines/${r.id}`, { prompt: 'Günlük raporu yaz' });
    later();
    await t.api('PATCH', `/api/routines/${r.id}`, { prompt: 'Haftalık raporu yaz' });
    expect(await history(r.id)).toEqual(['Haftalık raporu yaz', 'Günlük raporu yaz', 'Haftalık raporu yaz']);
  });

  it('geçmiş tutulmadan önce yapılmış rutinin ilk değişikliği de geri alınabilir', async () => {
    const r = await make();
    await t.db.db.delete(schema.routineRevisions);
    expect(await history(r.id)).toEqual(['Haftalık raporu yaz']);
    later();
    await t.api('PATCH', `/api/routines/${r.id}`, { prompt: 'Günlük raporu yaz' });
    expect(await history(r.id)).toEqual(['Günlük raporu yaz', 'Haftalık raporu yaz']);
  });

  it('rutin silinince geçmişi de gider', async () => {
    const r = await make();
    await t.api('DELETE', `/api/routines/${r.id}`);
    expect(await t.db.db.select().from(schema.routineRevisions)).toHaveLength(0);
  });
});
