import type { Routine, RoutineRun } from '@yumakbot/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '../src/db';
import { pageText } from '../src/services/routines';
import type * as SkillLink from '../src/services/skill-link';
import { testServer, type TestServer } from './helpers';

const page = vi.hoisted(() => ({ html: '', during: null as null | (() => Promise<unknown>) }));
vi.mock('../src/services/skill-link', async (original) => ({
  ...(await original<typeof SkillLink>()),
  // `during` runs while the page is being read, as a person's edit can.
  fetchPublicText: async () => {
    await page.during?.();
    return page.html;
  },
}));

describe('izlenen sayfa', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  it('sayfanın okunur metnini çıkarır', () => {
    expect(
      pageText('<html><style>p{}</style><script>x()</script><p>Fiyat:&nbsp;<b>100</b></p><!-- n --></html>'),
    ).toBe('Fiyat: 100');
  });

  it('bot yalnız sayfa değişince çalışır ve yeni metni alır', async () => {
    const bot = await t.bot();
    const r = (
      await t.api<Routine>('POST', '/api/routines', {
        botId: bot.id,
        name: 'Fiyat',
        prompt: 'Fiyat değişti mi?',
        schedule: { type: 'interval', minutes: 30 },
        watchUrl: 'https://ornek.com/urun',
      })
    ).body;
    const runs = async () => (await t.api<RoutineRun[]>('GET', `/api/routines/${r.id}/runs`)).body;
    const tick = async () => {
      t.now.value = new Date(t.now.value.getTime() + 31 * 60_000);
      await t.services.routines.tick();
      await t.services.turns.idle();
    };
    page.html = '<p>Fiyat 100</p>';
    await tick(); // the first read only sets what later ones are compared with
    await tick(); // unchanged
    expect(await runs()).toHaveLength(0);
    page.html = '<p>Fiyat 90</p>';
    await tick();
    expect(await runs()).toHaveLength(1);
    expect(t.engine.requests.at(-1)!.prompt).toContain('Fiyat 90');
    // Someone else wrote the page: the run is marked, so its turns change nothing without a card.
    const [row] = await t.db.db.select({ trigger: schema.routineRuns.trigger }).from(schema.routineRuns);
    expect(row!.trigger).toBe('watch');
    await tick();
    expect(await runs()).toHaveLength(1);
  });

  it('sayfa okunurken durdurulan rutin çalışmaz; o arada değişen takvim ezilmez', async () => {
    const bot = await t.bot();
    const r = (
      await t.api<Routine>('POST', '/api/routines', {
        botId: bot.id,
        name: 'Fiyat',
        prompt: 'Fiyat değişti mi?',
        schedule: { type: 'interval', minutes: 30 },
        watchUrl: 'https://ornek.com/urun',
      })
    ).body;
    const runs = async () => (await t.api<RoutineRun[]>('GET', `/api/routines/${r.id}/runs`)).body;
    const tick = async () => {
      t.now.value = new Date(t.now.value.getTime() + 31 * 60_000);
      await t.services.routines.tick();
      await t.services.turns.idle();
    };
    page.during = null;
    page.html = '<p>Fiyat 100</p>';
    await tick();
    // Paused while the changed page is read: the run that was due does not start.
    page.html = '<p>Fiyat 90</p>';
    page.during = () => t.api('PATCH', `/api/routines/${r.id}`, { enabled: false });
    await tick();
    expect(await runs()).toHaveLength(0);
    page.during = null;
    // Turned on again with a new schedule during the next read: the tick leaves the schedule the person set.
    await t.api('PATCH', `/api/routines/${r.id}`, { enabled: true });
    t.now.value = new Date(t.now.value.getTime() + 31 * 60_000);
    let set: string | null = null;
    page.html = '<p>Fiyat 80</p>';
    page.during = async () => {
      const after = await t.api<Routine>('PATCH', `/api/routines/${r.id}`, {
        schedule: { type: 'interval', minutes: 240 },
      });
      set = after.body.nextRunAt;
    };
    await t.services.routines.tick();
    await t.services.turns.idle();
    page.during = null;
    const now = (await t.api<Routine[]>('GET', '/api/routines')).body.find((x) => x.id === r.id)!;
    expect(set).not.toBeNull();
    expect(now.nextRunAt).toBe(set);
  });
});
