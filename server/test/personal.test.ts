import type { Bot, Connection, Memory, MemoryChange, Thread, VaultLogin } from '@yumakbot/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { translator } from '../src/i18n';
import { OWNER_ID } from '../src/users';
import { testServer, type Person, type TestServer } from './helpers';

describe('her kişinin kendisine ait olanlar', () => {
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

  const shared = async (name: string) => {
    const bot = await t.bot({ name });
    await t.api<Bot>('PUT', `/api/bots/${bot.id}/access`, { everyone: 'chat', people: {} });
    return bot;
  };
  const say = async (p: Person, threadId: string, text: string) => {
    const r = await p.api('POST', `/api/threads/${threadId}/messages`, {
      clientId: `c-${Math.random().toString(36).slice(2, 12)}`,
      text,
    });
    expect(r.status).toBeLessThan(300);
  };

  it('profil kişinindir; sunucu ayarını yalnızca yöneten değiştirir', async () => {
    await t.api('PATCH', '/api/settings', { userName: 'Erhan' });
    expect((await ayse.api('PATCH', '/api/settings', { userName: 'Ayşe', occupation: 'Satış' })).status).toBe(
      200,
    );
    expect((await ayse.api<Record<string, unknown>>('GET', '/api/settings')).body.userName).toBe('Ayşe');
    expect((await t.api<Record<string, unknown>>('GET', '/api/settings')).body.userName).toBe('Erhan');
    // Until they say their name, they are called by their username.
    expect((await mert.api<Record<string, unknown>>('GET', '/api/settings')).body.userName).toBe('mert');
    // The owner's own words about themselves are not anyone else's.
    await t.api('PATCH', '/api/settings', { focus: 'work', occupation: 'Mühendis', aboutMe: 'Kedim var' });
    const theirs = (await mert.api<Record<string, unknown>>('GET', '/api/settings')).body;
    expect(theirs.focus).toBeUndefined();
    expect(theirs.occupation ?? '').toBe('');
    expect(theirs.aboutMe ?? '').toBe('');
    // What every bot uses is the server's, not one member's.
    expect((await ayse.api('PATCH', '/api/settings', { effort: 'low' })).status).toBe(403);

    // The bot calls each person by their own name.
    const bot = await shared('Profil');
    const thread = (await ayse.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await say(ayse, thread.id, 'merhaba');
    await t.services.turns.idle();
    const prompt = t.engine.requests.filter((r) => r.botId === bot.id).at(-1)!.systemPrompt;
    expect(prompt).toContain('Ayşe');
    expect(prompt).not.toContain('Erhan');
    expect(prompt).not.toContain('Mühendis');
    expect(prompt).not.toContain('Kedim var');
  });

  it('kişinin hakkındaki notları yalnızca kendisi ve onun için çalışan bot görür', async () => {
    const bot = await shared('Not');
    expect(
      (await ayse.api('POST', '/api/memory', { scope: 'user', content: 'Ayşe çayı demli içer' })).status,
    ).toBe(200);
    expect((await ayse.api<Memory[]>('GET', '/api/memory')).body.map((m) => m.content)).toContain(
      'Ayşe çayı demli içer',
    );
    expect((await mert.api<Memory[]>('GET', '/api/memory')).body).toEqual([]);
    expect((await t.api<Memory[]>('GET', '/api/memory')).body.some((m) => m.content.includes('Ayşe'))).toBe(
      false,
    );
    // A member may not write a bot's notes straight away.
    expect(
      (await ayse.api('POST', '/api/memory', { scope: 'bot', botId: bot.id, content: 'x' })).status,
    ).toBe(403);
    expect((await ayse.api('POST', '/api/memory', { scope: 'bot', content: 'x' })).status).toBe(404);

    const mine = (await t.services.memory.visibleTo(bot.id, 'ayse')).user.map((m) => m.content);
    const his = (await t.services.memory.visibleTo(bot.id, 'mert')).user.map((m) => m.content);
    expect(mine).toContain('Ayşe çayı demli içer');
    expect(his).not.toContain('Ayşe çayı demli içer');
  });

  it('yalnızca konuşabilen kişinin istediği bot notu, botu yönetenin onayına gider', async () => {
    const bot = await shared('Ekip');
    const thread = (await ayse.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await say(ayse, thread.id, '[araç:memory_write {"content":"Raporlar cuma gider","scope":"bot"}]');
    await t.services.turns.idle();
    expect((await t.services.memory.list({ scope: 'bot', botId: bot.id })).map((m) => m.content)).toEqual([]);

    // Not Ayşe's to decide; the bot's owner sees it with who asked.
    expect((await ayse.api<MemoryChange[]>('GET', '/api/memory-changes')).body).toEqual([]);
    const waiting = (await t.api<MemoryChange[]>('GET', '/api/memory-changes')).body.filter(
      (c) => c.botId === bot.id,
    );
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.origin).toMatchObject({ kind: 'person' });
    expect((await ayse.api('POST', `/api/memory-changes/${waiting[0]!.id}/accept`, {})).status).toBe(404);
    expect((await t.api('POST', `/api/memory-changes/${waiting[0]!.id}/accept`, {})).status).toBe(200);
    expect((await t.services.memory.list({ scope: 'bot', botId: bot.id })).map((m) => m.content)).toEqual([
      'Raporlar cuma gider',
    ]);
  });

  it('kişisel bağlantı yalnızca sahibinin işinde kullanılır; takımınkini yalnızca yöneten kurar', async () => {
    const bot = await shared('Bağlı');
    const own = await ayse.api<Connection>('POST', '/api/connections', {
      name: 'Ayşenin CRM',
      url: 'https://crm.example.invalid/mcp',
      auth: 'none',
      allBots: true,
    });
    expect(own.status).toBe(200);
    expect(own.body.userId).toBe('ayse');
    expect((await ayse.api<Connection[]>('GET', '/api/connections')).body.map((c) => c.id)).toContain(
      own.body.id,
    );
    expect((await mert.api<Connection[]>('GET', '/api/connections')).body.map((c) => c.id)).not.toContain(
      own.body.id,
    );
    expect((await mert.api('GET', `/api/connections/${own.body.id}`)).status).toBe(404);
    expect((await mert.api('DELETE', `/api/connections/${own.body.id}`)).status).toBe(404);
    // Even those who look after the server do not see a person's own.
    expect((await admin.api('GET', `/api/connections/${own.body.id}`)).status).toBe(404);

    expect(
      (
        await ayse.api('POST', '/api/connections', {
          name: 'Takım',
          url: 'https://team.example.invalid/mcp',
          auth: 'none',
          team: true,
        })
      ).status,
    ).toBe(403);
    // The server calls the address itself: a member may not point it at itself or its network.
    for (const url of ['http://127.0.0.1:9/mcp', 'http://localhost:9/mcp', 'http://10.0.0.5/mcp']) {
      expect((await ayse.api('POST', '/api/connections', { name: 'İç', url, auth: 'none' })).status).toBe(
        400,
      );
    }
    const team = await admin.api<Connection>('POST', '/api/connections', {
      name: 'Takım',
      url: 'https://team.example.invalid/mcp',
      auth: 'none',
      allBots: true,
      team: true,
    });
    expect(team.status).toBe(200);
    expect(team.body.userId).toBeNull();
    expect((await mert.api<Connection[]>('GET', '/api/connections')).body.map((c) => c.id)).toContain(
      team.body.id,
    );
    expect((await mert.api('PATCH', `/api/connections/${team.body.id}`, { name: 'Benim' })).status).toBe(403);
    // A person's own opened to a bot they may not talk with is refused.
    const hidden = await t.bot({ name: 'Gizli' });
    expect(
      (await ayse.api('PUT', `/api/connections/${own.body.id}/bots`, { allBots: false, botIds: [hidden.id] }))
        .status,
    ).toBe(404);

    const down = async (person: string) =>
      (await t.services.connections.unavailableFor(bot.id, person)).map((c) => c.name);
    expect(await down('ayse')).toContain('Ayşenin CRM');
    expect(await down('mert')).not.toContain('Ayşenin CRM');
    const tools = await t.services.connections.toolsFor(
      bot.id,
      'mert',
      translator('tr'),
      new AbortController().signal,
    );
    expect(tools.some((x) => x.name.includes('crm'))).toBe(false);
  });

  it('kasadaki giriş, sahibinin işi dışında yazılmaz; aynı hesap iki kişide ayrı durur', async () => {
    const saved = await ayse.api<VaultLogin>('POST', '/api/vault', {
      site: 'banka.example',
      username: 'ortak',
      password: 'Ayse-123456',
    });
    expect(saved.status).toBe(200);
    expect(saved.body.userId).toBe('ayse');
    expect(
      (
        await mert.api('POST', '/api/vault', {
          site: 'banka.example',
          username: 'ortak',
          password: 'Mert-654321',
        })
      ).status,
    ).toBe(200);
    expect((await mert.api<VaultLogin[]>('GET', '/api/vault')).body.map((v) => v.id)).not.toContain(
      saved.body.id,
    );
    expect((await mert.api('PATCH', `/api/vault/${saved.body.id}`, { password: 'x-123456' })).status).toBe(
      404,
    );

    const typed = async (person: string) =>
      (await t.services.vault.forHost('banka.example', undefined, person)).map((c) => c.password);
    expect(await typed('ayse')).toEqual(['Ayse-123456']);
    expect(await typed('mert')).toEqual(['Mert-654321']);
    expect(await typed(OWNER_ID)).toEqual([]);

    // Moving one to the team is for those who look after the server.
    expect((await ayse.api('PATCH', `/api/vault/${saved.body.id}`, { team: true })).status).toBe(403);
    expect(
      (
        await admin.api('POST', '/api/vault', {
          site: 'ortak.example',
          username: 'ekip',
          password: 'Ekip-123456',
          team: true,
        })
      ).status,
    ).toBe(200);
    expect(await t.services.vault.forHost('ortak.example', undefined, 'mert')).toHaveLength(1);
  });
});
