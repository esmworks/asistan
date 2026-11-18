import type { Approval, Bot, BotSummary, PermissionRule, SearchHit, Thread, Ticket } from '@yumakbot/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OWNER_ID } from '../src/users';
import { testServer, type Person, type TestServer } from './helpers';

describe('kim neyi görür', () => {
  let t: TestServer;
  let ayse: Person;
  let mert: Person;
  let admin: Person;
  beforeAll(async () => {
    t = await testServer();
    ayse = await t.person('ayse');
    mert = await t.person('mert');
    admin = await t.person('yonetici', 'admin');
  });
  afterAll(() => t.dispose());

  const send = (p: Person, threadId: string, text: string) =>
    p.api('POST', `/api/threads/${threadId}/messages`, {
      clientId: `c-${Math.random().toString(36).slice(2, 12)}`,
      text,
    });

  it('paylaşılmamış bot başkasına yokmuş gibi görünür', async () => {
    const bot = await t.bot({ name: 'Gizli' });
    expect(bot.ownerUserId).toBe(OWNER_ID);
    const list = (await ayse.api<Bot[]>('GET', '/api/bots')).body;
    expect(list.some((b) => b.id === bot.id)).toBe(false);
    expect((await ayse.api('GET', `/api/bots/${bot.id}`)).status).toBe(404);
    expect((await ayse.api('GET', `/api/bots/${bot.id}/main-thread`)).status).toBe(404);
    // Those who look after the server may change every bot.
    expect((await admin.api<Bot>('GET', `/api/bots/${bot.id}`)).body.yourLevel).toBe('edit');
  });

  it('paylaşılan botla herkes kendi sohbetini yapar; kimse başkasınınkini okuyamaz', async () => {
    const bot = await t.bot({ name: 'Ortak' });
    const shared = await t.api<Bot>('PUT', `/api/bots/${bot.id}/access`, { everyone: 'chat', people: {} });
    expect(shared.status).toBe(200);

    const seen = (await ayse.api<Bot[]>('GET', '/api/bots')).body.find((b) => b.id === bot.id);
    expect(seen?.yourLevel).toBe('chat');
    const ownerThread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    const ayseThread = (await ayse.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    expect(ayseThread.id).not.toBe(ownerThread.id);
    expect(ayseThread.userId).toBe('ayse');

    await t.send(ownerThread.id, 'sahibin gizli notu');
    expect((await send(ayse, ayseThread.id, 'ayşenin sorusu')).status).toBeLessThan(300);
    await t.services.turns.idle();

    // Not the other's conversation, not even for those who look after the server.
    expect((await ayse.api('GET', `/api/threads/${ownerThread.id}/messages`)).status).toBe(404);
    expect((await admin.api('GET', `/api/threads/${ayseThread.id}/messages`)).status).toBe(404);
    expect((await mert.api('POST', `/api/threads/${ayseThread.id}/messages`, {})).status).toBe(404);
    const listed = (await ayse.api<Thread[]>('GET', `/api/bots/${bot.id}/threads`)).body;
    expect(listed.map((th) => th.id)).toEqual([ayseThread.id]);

    // Search and the sidebar hold only what is theirs.
    const hits = (await ayse.api<SearchHit[]>('GET', '/api/search?q=gizli')).body;
    expect(hits).toEqual([]);
    const own = (await ayse.api<SearchHit[]>('GET', '/api/search?q=ayşenin')).body;
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((h) => h.threadId === ayseThread.id)).toBe(true);
    const summary = (await ayse.api<BotSummary[]>('GET', '/api/summaries')).body.find(
      (x) => x.botId === bot.id,
    );
    expect(summary?.threadId).toBe(ayseThread.id);

    // Talking is not changing.
    expect((await ayse.api('PATCH', `/api/bots/${bot.id}`, { name: 'Benim' })).status).toBe(403);
    expect(
      (await ayse.api('PUT', `/api/bots/${bot.id}/access`, { everyone: 'edit', people: {} })).status,
    ).toBe(403);
  });

  it('paylaşım geri alınınca sohbet okunur ama yazılmaz', async () => {
    const bot = await t.bot({ name: 'Geçici' });
    await t.api('PUT', `/api/bots/${bot.id}/access`, { everyone: 'none', people: { mert: 'chat' } });
    const thread = (await mert.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    expect((await send(mert, thread.id, 'merhaba')).status).toBeLessThan(300);
    await t.services.turns.idle();
    await t.api('PUT', `/api/bots/${bot.id}/access`, { everyone: 'none', people: {} });
    expect((await mert.api('GET', `/api/threads/${thread.id}/messages`)).status).toBe(200);
    const refused = await send(mert, thread.id, 'tekrar');
    expect(refused.status).toBe(403);
  });

  it('kişinin yaptığı bot onundur; başkası onu silemez', async () => {
    const made = await ayse.api<Bot>('POST', '/api/bots', { name: 'Ayşenin botu' });
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ ownerUserId: 'ayse', yourLevel: 'edit' });
    expect((await mert.api('DELETE', `/api/bots/${made.body.id}`)).status).toBe(404);
    // A project folder opens the server's files: members do not pick one.
    expect((await ayse.api('PATCH', `/api/bots/${made.body.id}`, { projectDir: '/' })).status).toBe(403);
    // Sharing it to change makes Mert able to change it, not to remove it.
    await ayse.api('PUT', `/api/bots/${made.body.id}/access`, { everyone: 'none', people: { mert: 'edit' } });
    expect((await mert.api('PATCH', `/api/bots/${made.body.id}`, { description: 'x' })).status).toBe(200);
    expect((await mert.api('DELETE', `/api/bots/${made.body.id}`)).status).toBe(403);
  });

  it('sunucunun ayarları ve yedekleri yöneticilerin', async () => {
    expect((await ayse.api('PATCH', '/api/settings', { timezone: 'UTC' })).status).toBe(403);
    // A backup holds every person's conversations: only the owner takes one.
    expect((await admin.api('POST', '/api/backup')).status).toBe(403);
    expect((await admin.api('POST', '/api/backup/restore', {})).status).toBe(403);
    expect((await ayse.api('GET', '/api/usage')).status).toBe(403);
  });

  it('kurallar, onaylar, biletler kişinin erişimiyle süzülür', async () => {
    const hidden = await t.bot({ name: 'Kurallı' });
    await t.api('POST', '/api/rules', { list: 'block', pattern: 'Bash(rm *)', note: '', botId: hidden.id });
    const rules = (await ayse.api<PermissionRule[]>('GET', '/api/rules')).body;
    expect(rules.some((r) => r.botId === hidden.id)).toBe(false);
    // Rules for every bot are the server's.
    expect(
      (await ayse.api('POST', '/api/rules', { list: 'allow', pattern: 'Bash(*)', note: '', botId: null }))
        .status,
    ).toBe(403);

    const ownerThread = (await t.api<Thread>('GET', `/api/bots/${hidden.id}/main-thread`)).body;
    // The card waits for its answer; it is enough that it is there.
    await new Promise<void>((resolve) => {
      void t.services.approvals.ask({
        threadId: ownerThread.id,
        botId: hidden.id,
        turnId: null,
        kind: 'question',
        toolName: 'AskUserQuestion',
        input: {},
        summary: 'sahibe soru',
        timeoutMs: 2000,
        onCreated: async () => resolve(),
      });
    });
    const cards = (await ayse.api<Approval[]>('GET', '/api/approvals')).body;
    expect(cards.some((c) => c.threadId === ownerThread.id)).toBe(false);

    const ticket = (
      await t.api<Ticket>('POST', '/api/tickets', { title: 'Sahibin işi', assigneeBotId: hidden.id })
    ).body;
    const board = (await ayse.api<Ticket[]>('GET', '/api/tickets')).body;
    expect(board.some((k) => k.id === ticket.id)).toBe(false);
    expect((await ayse.api('DELETE', `/api/tickets/${ticket.id}`)).status).toBe(404);
    expect((await ayse.api('POST', '/api/tickets', { title: 'x', assigneeBotId: hidden.id })).status).toBe(
      404,
    );
  });

  it('canlı olaylar konuşmanın kişilerine gider', async () => {
    const bot = await t.bot({ name: 'Canlı' });
    await t.api('PUT', `/api/bots/${bot.id}/access`, { everyone: 'chat', people: {} });
    const ayseThread = (await ayse.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    t.services.access.forget();
    expect(await t.services.access.threadAudience(ayseThread.id)).toEqual(['ayse']);
    const routine = await t.services.threads.routineThread(bot.id, 'Rutin', null);
    // The bot's own work goes to those who may change it: its owner and the admins.
    expect((await t.services.access.threadAudience(routine.id)).sort()).toEqual(
      [OWNER_ID, 'yonetici'].sort(),
    );
  });
});
