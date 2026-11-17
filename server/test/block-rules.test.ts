import type { Approval, PermissionRule, Thread } from '@yumakbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testServer, waitFor, type TestServer } from './helpers';

const ROUTINE = { name: 'Sabah', prompt: 'Günaydın de.', schedule: { type: 'daily', time: '08:00' } };

describe('engel kuralları', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(async () => {
    await t.dispose();
  });

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const pending = async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body;

  it('engellenen araç hiçbir kipte, kart açılmadan çalışmaz', async () => {
    const rule = await t.api<PermissionRule>('POST', '/api/rules', {
      list: 'block',
      pattern: 'mcp__yumakbot__routine_create',
    });
    expect(rule.status).toBe(200);
    for (const mode of ['ask', 'auto'] as const) {
      const bot = await t.bot({ name: `Bot ${mode}`, permissionMode: mode });
      const thread = await main(bot.id);
      await t.send(thread.id, `[araç:routine_create ${JSON.stringify(ROUTINE)}]`);
      await t.services.turns.idle();
      expect(await pending()).toEqual([]);
      expect((await t.messages(thread.id)).at(-1)!.text).toContain('engelledi');
      expect((await t.services.routines.list(bot.id)).length).toBe(0);
    }
  });

  it('karttaki "hiç izin verme" aracı engeller; sonraki istek sormadan reddedilir', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, `[araç:routine_create ${JSON.stringify(ROUTINE)}]`);
    const card = await waitFor(async () => (await pending())[0]);
    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'deny', remember: true });
    await t.services.turns.idle();
    const rules = (await t.api<PermissionRule[]>('GET', '/api/rules')).body;
    expect(rules).toEqual([expect.objectContaining({ list: 'block', pattern: card.toolName })]);

    await t.send(thread.id, `[araç:routine_create ${JSON.stringify({ ...ROUTINE, name: 'Öğle' })}]`);
    await t.services.turns.idle();
    expect(await pending()).toEqual([]);
    expect((await t.messages(thread.id)).at(-1)!.text).toContain('engelledi');
  });
});
