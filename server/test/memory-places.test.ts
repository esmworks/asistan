import type { Approval, Memory, MemoryChange } from '@yumakbot/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { MEMORY_PROMPT_CHARS, PINNED_MEMORY_CHARS } from '../src/runtime/prompt';
import { placeOf, ROOM_NOTES_PER_PLACE, staleNotes } from '../src/services/memory';
import { newId } from '../src/util';
import { testServer, waitFor, type TestServer } from './helpers';

describe('hafıza: yer notları, sabitleme, unutma ve yarım kalan turlar', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const db = () => t.services.ctx.db;
  const main = async (botId: string) =>
    (await t.api<{ id: string }>('GET', `/api/bots/${botId}/main-thread`)).body;
  const slack = async (botId: string, channel: string, ts: string) => {
    const th = await t.services.threads.create(botId, { kind: 'team', userId: null, title: `#${channel}` });
    await db().insert(schema.slackThreads).values({ threadId: th.id, channel, threadTs: ts });
    return th;
  };
  const discord = async (botId: string, channel: string) => {
    const th = await t.services.threads.create(botId, { kind: 'team', userId: null, title: channel });
    await db()
      .insert(schema.discordThreads)
      .values({ threadId: th.id, serverId: 'S1', channel, rootId: newId() });
    return th;
  };
  /** Lets the turns finish, approving each card that asks about memory; returns what the cards said. */
  const approving = async () => {
    const asked: string[] = [];
    for (;;) {
      try {
        await t.services.turns.idle(300);
        return asked;
      } catch {
        const cards = (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body;
        for (const c of cards.filter((x) => x.toolName.startsWith('memory_'))) {
          asked.push(c.summary);
          await t.api('POST', `/api/approvals/${c.id}`, { decision: 'allow', answer: 'Onayla' });
        }
      }
    }
  };
  /** The prompt of the turn the next message starts. */
  const promptOf = async (threadId: string, text = 'kontrol') => {
    await t.send(threadId, text);
    await t.services.turns.idle();
    return t.engine.requests.filter((r) => r.threadId === threadId).at(-1)!.systemPrompt;
  };
  /** What `memory_search` answers in the conversation. */
  const searched = async (threadId: string) => {
    await t.send(threadId, '[araç:memory_search {}]');
    await t.services.turns.idle();
    return (await t.messages(threadId)).at(-1)!.text;
  };
  const notes = async () => (await t.api<Memory[]>('GET', '/api/memory')).body;
  const changes = async () => (await t.api<MemoryChange[]>('GET', '/api/memory-changes')).body;

  it('Slack kanalında yazılan yer notu yalnızca o kanalın turlarında görünür', async () => {
    const bot = await t.bot({ name: 'Kanalcı' });
    const a1 = await slack(bot.id, 'CA', '1.1');
    const a2 = await slack(bot.id, 'CA', '2.2');
    const b = await slack(bot.id, 'CB', '3.3');
    const d = await discord(bot.id, 'DA');
    const dm = await main(bot.id);
    await t.api('POST', '/api/memory', { scope: 'user', content: 'Kedisi Pamuk' });

    await t.send(a1.id, '[araç:memory_write {"content":"Cuma günü yayın yapılmaz","scope":"room"}]');
    // Everyone in the channel reads it, so the person is asked even while they are there.
    expect(await approving()).toEqual([
      'Kanalcı, bu kanalda ya da odada konuşan herkesin göreceği yer notlarına yazmak istiyor: “Cuma günü yayın yapılmaz”',
    ]);
    const saved = (await notes()).find((m) => m.scope === 'room')!;
    expect(saved).toMatchObject({ place: 'slack:CA', botId: null, userId: null });

    // The same channel's other thread sees it, in the prompt and in a search.
    const inA2 = await promptOf(a2.id);
    expect(inA2).toContain('Cuma günü yayın yapılmaz');
    expect(inA2).toContain('Bu yerin notları');
    expect(inA2).not.toContain('Pamuk');
    expect(await searched(a2.id)).toContain(saved.id);
    // Nowhere else does: another channel, Discord, the person's own chat.
    for (const other of [b, d, { id: dm.id }]) {
      expect(await promptOf(other.id)).not.toContain('Cuma günü yayın yapılmaz');
      expect(await searched(other.id)).not.toContain(saved.id);
    }
    // The person's own chat still reads the person's notes.
    expect(await promptOf(dm.id)).toContain('Pamuk');
  });

  it('Discord kanalının notu başka kanalda görünmez; yer dışında yer notu yazılamaz', async () => {
    const bot = await t.bot({ name: 'Sunucucu' });
    const d1 = await discord(bot.id, 'D1');
    const d2 = await discord(bot.id, 'D2');
    const dm = await main(bot.id);
    expect(await placeOf(t.services.ctx, d1)).toBe('discord:D1');
    await t.send(d1.id, '[araç:memory_write {"content":"Moderatör Ali","scope":"room"}]');
    await approving();
    expect(await promptOf(d2.id)).not.toContain('Moderatör Ali');

    // A chat of the person's own is in no place.
    await t.send(dm.id, '[araç:memory_write {"content":"Yersiz not","scope":"room"}]');
    await t.services.turns.idle();
    expect((await t.messages(dm.id)).at(-1)!.text).toContain('yer notu');
    expect((await notes()).map((m) => m.content)).toEqual(['Moderatör Ali']);
  });

  it('bir yerin en çok 50 notu olur', async () => {
    const bot = await t.bot({ name: 'Kalabalık' });
    const th = await slack(bot.id, 'CC', '9.9');
    for (let i = 0; i < ROOM_NOTES_PER_PLACE; i++)
      await t.services.memory.create({
        scope: 'room',
        botId: null,
        place: 'slack:CC',
        content: `not ${i}`,
        source: 'user',
      });
    await expect(
      t.services.memory.create({
        scope: 'room',
        botId: null,
        place: 'slack:CC',
        content: 'fazla',
        source: 'user',
      }),
    ).rejects.toMatchObject({ status: 400, key: 'error.memoryRoomFull' });
    await t.send(th.id, '[araç:memory_write {"content":"bir tane daha","scope":"room"}]');
    await t.services.turns.idle();
    expect((await t.messages(th.id)).at(-1)!.text).toContain('sınırı doldu');
    expect(await t.api('GET', '/api/memory')).toMatchObject({ status: 200 });
    expect((await notes()).length).toBe(ROOM_NOTES_PER_PLACE);
  });

  it('odanın notunu o odanın sahibi görür ve siler; başkası görmez', async () => {
    const bot = await t.bot({ name: 'Odacı' });
    const ayse = await t.person('ayse');
    const mert = await t.person('mert');
    const room = await t.services.threads.create(bot.id, { kind: 'room', userId: 'ayse', title: 'Oda' });
    const note = await t.services.memory.create({
      scope: 'room',
      botId: null,
      place: `room:${room.id}`,
      content: 'Toplantı salı',
      source: 'user',
    });
    expect((await ayse.api<Memory[]>('GET', '/api/memory')).body.map((m) => m.id)).toContain(note.id);
    expect((await mert.api<Memory[]>('GET', '/api/memory')).body.map((m) => m.id)).not.toContain(note.id);
    expect((await mert.api('DELETE', `/api/memory/${note.id}`)).status).toBe(404);
    // The server's owner reaches every chat app channel, not a person's rooms.
    const slackNote = await t.services.memory.create({
      scope: 'room',
      botId: null,
      place: 'slack:CZ',
      content: 'Kanal notu',
      source: 'user',
    });
    expect((await notes()).map((m) => m.id)).toContain(slackNote.id);
    expect((await ayse.api<Memory[]>('GET', '/api/memory')).body.map((m) => m.id)).not.toContain(
      slackNote.id,
    );
    expect((await ayse.api('DELETE', `/api/memory/${note.id}`)).status).toBe(200);
  });

  it('sabitlenen not istemde önce gelir, bayat sayılmaz ve botun değişikliği karta düşer', async () => {
    const bot = await t.bot({ name: 'Sabitçi' });
    const th = await main(bot.id);
    const post = async (body: object) => (await t.api<Memory>('POST', '/api/memory', body)).body;
    await post({ scope: 'user', content: 'birinci not' });
    await post({ scope: 'user', content: 'ikinci not' });
    const last = await post({ scope: 'user', content: 'son not' });
    const pinned = await t.api<Memory>('PATCH', `/api/memory/${last.id}`, { pinned: true });
    expect(pinned.body).toMatchObject({ pinned: true, content: 'son not', updatedAt: last.updatedAt });
    const prompt = await promptOf(th.id);
    expect(prompt.indexOf('son not')).toBeLessThan(prompt.indexOf('birinci not'));
    // A pin is a line in the history, without words.
    const lines = (
      await t.api<{ action: string; before: unknown; after: unknown }[]>('GET', '/api/memory-history')
    ).body;
    expect(lines.find((l) => l.action === 'pin')).toMatchObject({ before: null, after: null });

    const old = {
      ...last,
      pinned: true,
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
    };
    expect(staleNotes([old], [], new Date())).toEqual([]);
    expect(staleNotes([{ ...old, pinned: false }], [], new Date())).toHaveLength(1);

    // A bot changing its own pinned note asks first, though it would not for an unpinned one.
    const mine = await post({ scope: 'bot', botId: bot.id, content: 'benim notum' });
    await t.send(th.id, `[araç:memory_update {"id":"${mine.id}","content":"değişti"}]`);
    await t.services.turns.idle();
    expect((await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body).toHaveLength(0);
    await t.api('PATCH', `/api/memory/${mine.id}`, { pinned: true });
    await t.send(th.id, `[araç:memory_update {"id":"${mine.id}","content":"yine değişti"}]`);
    expect(await approving()).toHaveLength(1);
    await t.send(th.id, `[araç:memory_forget {"id":"${mine.id}"}]`);
    expect(await approving()).toHaveLength(1);
    expect(MEMORY_PROMPT_CHARS).toBeGreaterThan(PINNED_MEMORY_CHARS * 3);
  });

  it('sabitlenen notların toplamı sınırı aşamaz', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const m = (await t.api<Memory>('POST', '/api/memory', { scope: 'user', content: `${i}`.repeat(1990) }))
        .body;
      ids.push(m.id);
    }
    for (const id of ids.slice(0, 3))
      expect((await t.api('PATCH', `/api/memory/${id}`, { pinned: true })).status).toBe(200);
    const refused = await t.api<{ error: string }>('PATCH', `/api/memory/${ids[3]}`, { pinned: true });
    expect(refused.status).toBe(400);
    // Unpinning one makes room again.
    await t.api('PATCH', `/api/memory/${ids[0]}`, { pinned: false });
    expect((await t.api('PATCH', `/api/memory/${ids[3]}`, { pinned: true })).status).toBe(200);
  });

  it('silinen notun metni geçmişte kalmaz, satırların kendisi kalır', async () => {
    const m = (await t.api<Memory>('POST', '/api/memory', { scope: 'user', content: 'gizli adres Kadıköy' }))
      .body;
    await t.api('PATCH', `/api/memory/${m.id}`, { content: 'gizli adres Beşiktaş' });
    type Line = { action: string; targetId: string; before: unknown; after: unknown };
    const before = (await t.api<Line[]>('GET', '/api/memory-history')).body.filter(
      (l) => l.targetId === m.id,
    );
    expect(before.map((l) => l.after)).toContain('gizli adres Beşiktaş');
    await t.api('DELETE', `/api/memory/${m.id}`);
    const lines = (await t.api<Line[]>('GET', '/api/memory-history')).body.filter((l) => l.targetId === m.id);
    expect(lines.map((l) => l.action)).toEqual(['create', 'update', 'delete']);
    expect(lines.every((l) => l.before === null && l.after === null)).toBe(true);
    expect(JSON.stringify(lines)).not.toContain('Kadıköy');
  });

  it('botu kalıcı silmek notlarının geçmiş satırlarını da siler', async () => {
    const bot = await t.bot({ name: 'Gidecek' });
    await t.api('POST', '/api/memory', { scope: 'bot', botId: bot.id, content: 'botun sırrı' });
    const rows = () =>
      db()
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.owner, `bot:${bot.id}`));
    expect(await rows()).not.toHaveLength(0);
    await t.api('POST', `/api/bots/${bot.id}/archive`);
    expect((await t.api('DELETE', `/api/bots/${bot.id}`)).status).toBe(200);
    expect(await rows()).toHaveLength(0);
  });

  it('kaydedilirken not bu arada değiştiyse 409 verir; sürüm verilmezse eskisi gibi kaydeder', async () => {
    const m = (await t.api<Memory>('POST', '/api/memory', { scope: 'user', content: 'ilk' })).body;
    expect((await t.api('PATCH', `/api/memory/${m.id}`, { content: 'ikinci' })).status).toBe(200);
    const stale = await t.api('PATCH', `/api/memory/${m.id}`, { content: 'üçüncü', updatedAt: m.updatedAt });
    expect(stale.status).toBe(409);
    expect((await notes())[0]!.content).toBe('ikinci');
    const now = (await notes())[0]!;
    expect(
      (await t.api('PATCH', `/api/memory/${m.id}`, { content: 'üçüncü', updatedAt: now.updatedAt })).status,
    ).toBe(200);
    expect((await t.api('PATCH', `/api/memory/${m.id}`, {})).status).toBe(400);
  });

  it('unutma adımı silinen notun sözlerini söyler', async () => {
    const bot = await t.bot({ name: 'Unutkan' });
    const th = await main(bot.id);
    const mine = (
      await t.api<Memory>('POST', '/api/memory', {
        scope: 'bot',
        botId: bot.id,
        content: 'eski adres Kadıköy',
      })
    ).body;
    await t.send(th.id, `[araç:memory_forget {"id":"${mine.id}"}]`);
    await t.services.turns.idle();
    expect((await t.messages(th.id)).at(-1)!.text).toContain('eski adres Kadıköy');
  });

  it('durdurulan turun yazdığı not geri alınır ve onay bekleyenlere düşer; kabul edilince yazılır', async () => {
    const bot = await t.bot({ name: 'Yarım' });
    const th = await main(bot.id);
    await t.send(th.id, '[araç:memory_write {"content":"yarım kalan not","scope":"bot"}] [bekle:10000]');
    await waitFor(async () => (await notes()).length === 1);
    await t.api('POST', `/api/threads/${th.id}/stop`);
    await t.services.turns.idle();
    expect(await notes()).toHaveLength(0);
    const [waiting] = await changes();
    expect(waiting).toMatchObject({
      action: 'write',
      content: 'yarım kalan not',
      scope: 'bot',
      botId: bot.id,
      origin: { kind: 'stopped', name: 'Yarım' },
    });
    // The words of the taken-back note stay in no history line.
    const lines = (await t.api<{ before: unknown; after: unknown }[]>('GET', '/api/memory-history')).body;
    expect(JSON.stringify(lines)).not.toContain('yarım kalan not');
    expect((await t.api('POST', `/api/memory-changes/${waiting!.id}/accept`, {})).status).toBe(200);
    expect((await notes()).map((m) => m.content)).toEqual(['yarım kalan not']);
  });

  it('durdurulan turun değiştirdiği ve sildiği not eski haline döner', async () => {
    const bot = await t.bot({ name: 'Kararsız' });
    const th = await main(bot.id);
    const a = (
      await t.api<Memory>('POST', '/api/memory', { scope: 'bot', botId: bot.id, content: 'adres Kadıköy' })
    ).body;
    const b = (
      await t.api<Memory>('POST', '/api/memory', { scope: 'bot', botId: bot.id, content: 'kedi Pamuk' })
    ).body;
    await t.send(
      th.id,
      `[araç:memory_update {"id":"${a.id}","content":"adres Beşiktaş"}] [araç:memory_forget {"id":"${b.id}"}] [bekle:10000]`,
    );
    await waitFor(async () => (await notes()).length === 1);
    await t.api('POST', `/api/threads/${th.id}/stop`);
    await t.services.turns.idle();
    expect((await notes()).map((m) => m.content).sort()).toEqual(['adres Kadıköy', 'kedi Pamuk']);
    const waiting = await changes();
    expect(waiting.map((c) => c.action).sort()).toEqual(['forget', 'update']);
    expect(waiting.every((c) => c.origin.kind === 'stopped')).toBe(true);
    const update = waiting.find((c) => c.action === 'update')!;
    expect(update).toMatchObject({ before: 'adres Kadıköy', content: 'adres Beşiktaş' });
    await t.api('POST', `/api/memory-changes/${update.id}/accept`, {});
    expect((await notes()).map((m) => m.content)).toContain('adres Beşiktaş');
  });

  it('biten turun yazdığı not kalır', async () => {
    const bot = await t.bot({ name: 'Tamam' });
    const th = await main(bot.id);
    await t.send(th.id, '[araç:memory_write {"content":"kalıcı not","scope":"bot"}]');
    await t.services.turns.idle();
    expect((await notes()).map((m) => m.content)).toEqual(['kalıcı not']);
    expect(await changes()).toHaveLength(0);
  });

  it('oda silinince o odanın notları, bekleyen değişiklikleri ve geçmiş satırları da silinir; başka odanınkiler kalır', async () => {
    const bot = await t.bot({ name: 'Odacı' });
    const make = async (title: string) =>
      (await t.api<{ id: string }>('POST', '/api/rooms', { title, botIds: [bot.id] })).body;
    const gone = await make('Silinecek');
    const kept = await make('Kalacak');
    const note = (roomId: string, content: string) =>
      t.services.memory.create({
        scope: 'room',
        botId: null,
        place: `room:${roomId}`,
        content,
        source: 'user',
      });
    await note(gone.id, 'silinecek odanın notu');
    await note(kept.id, 'kalacak odanın notu');
    const propose = (roomId: string, content: string) =>
      t.services.memory.propose({
        action: 'write',
        memoryId: null,
        scope: 'room',
        botId: null,
        place: `room:${roomId}`,
        site: null,
        content,
        before: null,
        proposedBy: bot.id,
        origin: { kind: 'stopped', name: bot.name },
        userId: null,
        threadId: null,
        sourceUrl: null,
      });
    await propose(gone.id, 'bekleyen silinecek');
    await propose(kept.id, 'bekleyen kalacak');
    const lines = (roomId: string) =>
      db()
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.owner, `room:room:${roomId}`));
    expect(await lines(gone.id)).not.toHaveLength(0);

    expect((await t.api('DELETE', `/api/rooms/${gone.id}`)).status).toBe(200);

    expect((await notes()).map((m) => m.content)).toEqual(['kalacak odanın notu']);
    expect((await changes()).map((c) => c.content)).toEqual(['bekleyen kalacak']);
    expect(await lines(gone.id)).toHaveLength(0);
    expect(await lines(kept.id)).not.toHaveLength(0);
  });

  it('turda kartla onaylanan ortak not ile doğrudan yazılan bot notu birlikte yazılırsa, durdurulunca yalnızca doğrudan yazılan geri alınır', async () => {
    const bot = await t.bot({ name: 'İkili' });
    const th = await main(bot.id);
    await t.send(
      th.id,
      '[araç:memory_write {"content":"ortak not","scope":"user"}] [araç:memory_write {"content":"kendi notum","scope":"bot"}] [bekle:10000]',
    );
    // The shared note asks on a card; the turn goes on only after the person says yes.
    await waitFor(async () => {
      const cards = (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body;
      for (const c of cards.filter((x) => x.toolName.startsWith('memory_')))
        await t.api('POST', `/api/approvals/${c.id}`, { decision: 'allow', answer: 'Onayla' });
      return (await notes()).length === 2;
    });
    await t.api('POST', `/api/threads/${th.id}/stop`);
    await t.services.turns.idle();
    // What the person approved on a card stays; the bot's own note is taken back and waits.
    expect((await notes()).map((m) => m.content)).toEqual(['ortak not']);
    const waiting = await changes();
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({
      action: 'write',
      content: 'kendi notum',
      scope: 'bot',
      origin: { kind: 'stopped', name: 'İkili' },
    });
  });

  it('sabitlenmiş notu sınırı aşacak biçimde uzatan memory_update fırlatmaz, botun anlayacağı cevabı verir', async () => {
    const bot = await t.bot({ name: 'Sığmayan' });
    const th = await main(bot.id);
    const post = async (content: string) =>
      (await t.api<Memory>('POST', '/api/memory', { scope: 'user', content })).body;
    for (let i = 0; i < 3; i++) {
      const m = await post(`${i}`.repeat(1990));
      expect((await t.api('PATCH', `/api/memory/${m.id}`, { pinned: true })).status).toBe(200);
    }
    const small = await post('kısa');
    expect((await t.api('PATCH', `/api/memory/${small.id}`, { pinned: true })).status).toBe(200);
    await t.send(th.id, `[araç:memory_update {"id":"${small.id}","content":"${'z'.repeat(1990)}"}]`);
    // A pinned note is the person's choice, so the bot asks on a card before the limit is even met.
    await approving();
    expect((await t.messages(th.id)).at(-1)!.text).toContain('Sabitlenen notların sınırı dolu');
    expect((await notes()).find((m) => m.id === small.id)!.content).toBe('kısa');
  });

  it('turun yazdığı notu tur sürerken kişi düzenlerse ya da sabitlerse durdurulunca olduğu gibi kalır ve bekleyen değişiklik doğmaz', async () => {
    const bot = await t.bot({ name: 'Çakışan' });
    const th = await main(bot.id);
    for (const how of ['edit', 'pin'] as const) {
      const text = `${how} notu`;
      await t.send(th.id, `[araç:memory_write {"content":"${text}","scope":"bot"}] [bekle:10000]`);
      await waitFor(async () => (await notes()).some((m) => m.content === text));
      const mine = (await notes()).find((m) => m.content === text)!;
      await t.api(
        'PATCH',
        `/api/memory/${mine.id}`,
        how === 'edit' ? { content: `${text} (kişi düzeltti)` } : { pinned: true },
      );
      await t.api('POST', `/api/threads/${th.id}/stop`);
      await t.services.turns.idle();
    }
    expect((await notes()).map((m) => m.content).sort()).toEqual(['edit notu (kişi düzeltti)', 'pin notu']);
    expect(await changes()).toEqual([]);
  });
});
