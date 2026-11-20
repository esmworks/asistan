import type { Memory, Thread } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { noteUntil } from '../src/tools';
import { testServer, type TestServer } from './helpers';

const DAY = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();

describe('süresi dolan notlar', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const notes = async () => (await t.api<Memory[]>('GET', '/api/memory')).body;
  const note = (botId: string, content: string, validUntil: string | null) =>
    t.services.memory.create({ scope: 'bot', botId, content, source: 'user', validUntil });

  it('until: yalnız tarih günün sonu, saat verilmişse kullanıcının saat dilimi sayılır', () => {
    expect(noteUntil('2026-11-27', 'Europe/Istanbul')).toBe('2026-11-27T20:59:00.000Z');
    expect(noteUntil('2026-11-27T18:00', 'Europe/Istanbul')).toBe('2026-11-27T15:00:00.000Z');
    expect(noteUntil('2026-11-27T18:00:00Z', 'Europe/Istanbul')).toBe('2026-11-27T18:00:00.000Z');
    expect(noteUntil('', 'Europe/Istanbul')).toBeNull();
    expect(noteUntil('yarın', 'Europe/Istanbul')).toBeUndefined();
    expect(noteUntil('2026-11-31', 'Europe/Istanbul')).toBeUndefined();
  });

  it('süresi geçen not komut isteminde görünmez, süresi gelmemiş olan tarihiyle görünür', async () => {
    const a = await t.bot({ name: 'Ali' });
    const th = await main(a.id);
    await note(a.id, 'Bu hafta evden çalışıyor', iso(-1));
    await note(a.id, 'Cumaya kadar izinde', iso(3));
    await note(a.id, 'Kahve sever', null);
    await t.send(th.id, 'merhaba');
    await t.services.turns.idle();
    const prompt = t.engine.requests.at(-1)!.systemPrompt;
    expect(prompt).not.toContain('Bu hafta evden çalışıyor');
    expect(prompt).toContain('Kahve sever');
    expect(prompt).toMatch(/\(\d{4}-\d{2}-\d{2} tarihine kadar geçerli\) Cumaya kadar izinde/);
  });

  it('bot araması süresi geçen notu bulmaz', async () => {
    const a = await t.bot({ name: 'Ali' });
    const th = await main(a.id);
    await note(a.id, 'Taşınma günü pazartesi', iso(-2));
    await note(a.id, 'Taşınma kutuları garajda', iso(2));
    await t.send(th.id, '[araç:memory_search {"query":"Taşınma"}]');
    await t.services.turns.idle();
    const answer = (await t.messages(th.id)).at(-1)!.text;
    expect(answer).toContain('garajda');
    expect(answer).not.toContain('pazartesi');
    expect(await t.services.memory.search([a.id], null, 'Taşınma')).toHaveLength(1);
  });

  it('bot memory_write ile süre koyar, memory_update ile değiştirir ve boş değerle kaldırır', async () => {
    const a = await t.bot({ name: 'Ali' });
    const th = await main(a.id);
    await t.send(th.id, '[araç:memory_write {"content":"Ali izinde","until":"2999-01-05"}]');
    await t.services.turns.idle();
    const [saved] = await notes();
    expect(saved!.validUntil).toMatch(/^2999-01-05T/);

    await t.send(
      th.id,
      `[araç:memory_update {"id":"${saved!.id}","content":"Ali izinde","until":"2999-02-01T10:00:00Z"}]`,
    );
    await t.services.turns.idle();
    expect((await notes())[0]!.validUntil).toBe('2999-02-01T10:00:00.000Z');

    // Left out, the date stays.
    await t.send(th.id, `[araç:memory_update {"id":"${saved!.id}","content":"Ali hâlâ izinde"}]`);
    await t.services.turns.idle();
    expect((await notes())[0]!.validUntil).toBe('2999-02-01T10:00:00.000Z');

    await t.send(th.id, `[araç:memory_update {"id":"${saved!.id}","content":"Ali hâlâ izinde","until":""}]`);
    await t.services.turns.idle();
    expect((await notes())[0]!.validUntil).toBeNull();
  });

  it('geçersiz ya da geçmiş until not yazdırmaz', async () => {
    const a = await t.bot({ name: 'Ali' });
    const th = await main(a.id);
    await t.send(th.id, '[araç:memory_write {"content":"x","until":"yarın"}]');
    await t.services.turns.idle();
    expect((await t.messages(th.id)).at(-1)!.text).toContain('geçerli bir tarih değil');
    await t.send(th.id, '[araç:memory_write {"content":"y","until":"2001-01-01"}]');
    await t.services.turns.idle();
    expect((await t.messages(th.id)).at(-1)!.text).toContain('geçmişte kalmış');
    expect(await notes()).toHaveLength(0);
  });

  it('süresi geçmiş notla aynı bilgi yeniden yazılınca yeni tarihiyle kaydedilir ve bota görünür', async () => {
    const a = await t.bot({ name: 'Ali' });
    const th = await main(a.id);
    const old = await note(a.id, 'Ali izinde', iso(-1));
    await t.send(th.id, '[araç:memory_write {"content":"Ali izinde","until":"2999-01-05"}]');
    await t.services.turns.idle();
    expect((await t.messages(th.id)).at(-1)!.text).not.toContain(old.id);
    const kept = (await notes()).filter((m) => m.content === 'Ali izinde');
    expect(kept).toHaveLength(2);
    expect(kept.find((m) => m.id !== old.id)!.validUntil).toMatch(/^2999-01-05T/);
    await t.send(th.id, 'merhaba');
    await t.services.turns.idle();
    expect(t.engine.requests.at(-1)!.systemPrompt).toContain('Ali izinde');
  });

  it('süresi dolanlar silinmez; ayrı listelenir, Bugün sayısında olur, unutulmuş notlar listesine karışmaz', async () => {
    const a = await t.bot({ name: 'Ali' });
    const gone = await note(a.id, 'Geçen hafta tatildeydi', iso(-3));
    await note(a.id, 'Hâlâ geçerli', iso(3));
    expect((await notes()).map((m) => m.id)).toContain(gone.id);
    expect((await t.services.memory.expired()).map((m) => m.id)).toEqual([gone.id]);
    expect((await t.api<{ expiredMemory?: number }>('GET', '/api/today')).body.expiredMemory).toBe(1);
    // Looked at as a note nobody uses it would be offered twice.
    expect((await t.api<Memory[]>('GET', '/api/memory-stale')).body).toHaveLength(0);
  });

  it('kişi tarihi düzenleyip kaldırınca not yine bota görünür', async () => {
    const a = await t.bot({ name: 'Ali' });
    const gone = await note(a.id, 'Geçen hafta tatildeydi', iso(-3));
    expect(await t.services.memory.search([a.id], null)).toHaveLength(0);
    const patched = await t.api<Memory>('PATCH', `/api/memory/${gone.id}`, { validUntil: iso(5) });
    expect(patched.body.validUntil).toBe(new Date(patched.body.validUntil!).toISOString());
    expect(patched.body.updatedAt).toBe(gone.updatedAt);
    expect(await t.services.memory.search([a.id], null)).toHaveLength(1);
    await t.api('PATCH', `/api/memory/${gone.id}`, { validUntil: null });
    expect((await notes())[0]!.validUntil).toBeNull();
    expect((await t.api('PATCH', `/api/memory/${gone.id}`, {})).status).toBe(400);
  });

  it('kişi elle yazdığı nota tarih koyabilir', async () => {
    const a = await t.bot({ name: 'Ali' });
    const r = await t.api<Memory>('POST', '/api/memory', {
      scope: 'bot',
      botId: a.id,
      content: 'Gezi boyunca otelde',
      validUntil: iso(4),
    });
    expect(r.body.validUntil).not.toBeNull();
  });
});
