import type { Bot, Meeting, MeetingMinutes, Memory, MemoryChange, Message, Room } from '@yumakbot/shared';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { translator } from '../src/i18n';
import { meetingNote, parseMinutes } from '../src/services/meetings';
import { testServer, type TestServer } from './helpers';

describe('toplantı tutanağı', () => {
  let t: TestServer;
  let ada: Bot;
  let bora: Bot;
  beforeEach(async () => {
    t = await testServer();
    ada = await t.bot({ name: 'Ada' });
    bora = await t.bot({ name: 'Bora' });
  });
  afterEach(() => t.dispose());

  const room = async (extra: object = {}) => {
    const r = await t.api<Room>('POST', '/api/rooms', {
      title: 'Planlama',
      botIds: [ada.id, bora.id],
      ...extra,
    });
    expect(r.status).toBe(200);
    return r.body;
  };
  const say = async (roomId: string, text: string) => {
    const r = await t.api<Message>('POST', `/api/rooms/${roomId}/messages`, {
      clientId: `c-${Math.random().toString(36).slice(2, 12)}`,
      text,
    });
    expect(r.status).toBe(201);
    await t.services.turns.idle();
    return r.body;
  };
  const meetings = async (roomId: string) =>
    (await t.api<Meeting[]>('GET', `/api/rooms/${roomId}/meetings`)).body;
  const call = (roomId: string, meetingId: string, what: string, body?: unknown) =>
    t.api<Meeting>('POST', `/api/rooms/${roomId}/meetings/${meetingId}/${what}`, body);
  /** Everything said in the room so far happened long ago: the next message comes after a pause. */
  const longAgo = (roomId: string) =>
    t.db.db
      .update(schema.messages)
      .set({ createdAt: sql`${schema.messages.createdAt} - interval '3 hours'` })
      .where(eq(schema.messages.threadId, roomId));
  const minutes = (o: Partial<Record<string, unknown>> = {}) =>
    JSON.stringify({
      title: 'Lansman',
      summary: 'Lansman tarihi konuşuldu.',
      decisions: ['Lansman 1 Aralık’ta'],
      tasks: [
        { text: 'Basın bültenini yaz', owner: 'ada', due: '2026-11-25' },
        { text: 'Bütçeyi çıkar', owner: 'Kullanıcı', due: 'cuma' },
      ],
      questions: ['Davetli listesi?'],
      ...o,
    });
  const written = async () => {
    await t.services.meetings.idle();
  };

  it('ilk konuşmada sorar; evet denince tutar, bitince tutanağı yazar', async () => {
    const r = await room();
    expect(r.minutes).toBe('ask');
    await say(r.id, 'Lansmanı konuşalım');
    const [m] = await meetings(r.id);
    expect(m).toMatchObject({ status: 'asked' });
    // The question is a line of the room's own: the app draws it as a card; the bots never read it.
    const card = (await t.messages(r.id)).find((x) => x.props.meeting);
    expect(card).toMatchObject({
      role: 'system',
      author: 'meeting',
      props: { meeting: { id: m!.id, stage: 'start' } },
    });
    expect(t.engine.requests.some((q) => q.prompt.includes('toplantı mı'))).toBe(false);
    expect((await t.api<Room>('GET', `/api/rooms/${r.id}`)).body.meeting).toEqual({
      id: m!.id,
      status: 'asked',
    });

    expect((await call(r.id, m!.id, 'answer', { answer: 'yes' })).body.status).toBe('active');
    await say(r.id, 'Ada basın bültenini yazsın');
    // A message while the meeting goes on asks nothing more.
    expect(await meetings(r.id)).toHaveLength(1);

    t.engine.completer = () => `İşte tutanak:\n${minutes()}`;
    expect((await call(r.id, m!.id, 'end')).body.status).toBe('writing');
    await written();
    const [done] = await meetings(r.id);
    expect(done!.status).toBe('draft');
    expect(done!.minutes).toEqual({
      title: 'Lansman',
      summary: 'Lansman tarihi konuşuldu.',
      decisions: ['Lansman 1 Aralık’ta'],
      tasks: [
        // A member's name, in any case, becomes the bot; a person's stays a name; an odd day is dropped.
        { text: 'Basın bültenini yaz', owner: 'Ada', botId: ada.id, due: '2026-11-25' },
        { text: 'Bütçeyi çıkar', owner: 'Kullanıcı', botId: null, due: null },
      ],
      questions: ['Davetli listesi?'],
    });
    const asked = t.engine.completions.at(-1)!;
    expect(asked.system).toContain('<meeting>');
    expect(asked.user).toContain('<people>\n- Kullanıcı\n- Ada\n- Bora\n</people>');
    expect(asked.user).toContain('<m from="Kullanıcı">Lansmanı konuşalım</m>');
    expect(asked.user).toContain('<m from="Kullanıcı">Ada basın bültenini yazsın</m>');
    expect(asked.user).toMatch(/<m from="Ada">Yankı:/);
    // The room's own lines are not part of the meeting.
    expect(asked.user).not.toContain('toplantı mı');
    const end = (await t.messages(r.id)).filter((x) => x.props.meeting).at(-1);
    expect(end!.props.meeting).toEqual({ id: m!.id, stage: 'end' });
  });

  it('“hiç sorma” odayı kapatır; “hep tut” sormadan tutar', async () => {
    const r = await room();
    await say(r.id, 'Merhaba');
    const [m] = await meetings(r.id);
    await call(r.id, m!.id, 'answer', { answer: 'never' });
    // A declined meeting is not listed.
    expect(await meetings(r.id)).toEqual([]);
    expect((await t.api<Room>('GET', `/api/rooms/${r.id}`)).body.minutes).toBe('never');
    await longAgo(r.id);
    await say(r.id, 'Yeni konu');
    expect(await meetings(r.id)).toEqual([]);

    await t.api('PATCH', `/api/rooms/${r.id}`, { minutes: 'always' });
    await longAgo(r.id);
    await say(r.id, 'Haftalık toplantı');
    const [kept] = await meetings(r.id);
    expect(kept!.status).toBe('active');
    const startCard = (await t.messages(r.id)).filter((x) => x.props.meeting).at(-1)!;
    expect(startCard.text).toBe('Toplantı tutanağı tutuluyor.');
  });

  it('ara vermeden süren konuşma yeniden sorulmaz; uzun bir aradan sonra sorulur', async () => {
    const r = await room();
    await say(r.id, 'Bir');
    const [m] = await meetings(r.id);
    await call(r.id, m!.id, 'answer', { answer: 'no' });
    await say(r.id, 'İki');
    expect(await t.db.db.select().from(schema.meetings)).toHaveLength(1);
    await longAgo(r.id);
    await say(r.id, 'Üç');
    const rows = await t.db.db.select().from(schema.meetings);
    expect(rows.map((x) => x.status).sort()).toEqual(['asked', 'declined']);
  });

  it('sessiz kalan toplantı kendiliğinden biter; cevapsız soru düşer', async () => {
    const r = await room();
    await say(r.id, 'Başlayalım');
    const [m] = await meetings(r.id);
    await call(r.id, m!.id, 'answer', { answer: 'yes' });
    t.engine.completer = () => minutes();
    t.now.value = new Date(Date.now() + 10 * 60_000);
    await t.services.meetings.sweep();
    expect((await meetings(r.id))[0]!.status).toBe('active');
    t.now.value = new Date(Date.now() + 31 * 60_000);
    await t.services.meetings.sweep();
    await written();
    const [ended] = await meetings(r.id);
    expect(ended!.status).toBe('draft');
    // Its lines end with the last one written, not with the quiet after it.
    expect(new Date(ended!.endedAt!).getTime()).toBeLessThan(Date.now() + 60_000);

    const other = await room({ title: 'Diğer' });
    await say(other.id, 'Selam');
    await t.services.meetings.sweep();
    const [q] = await t.db.db.select().from(schema.meetings).where(eq(schema.meetings.roomId, other.id));
    expect(q!.status).toBe('declined');
  });

  it('yazılamayan tutanak yeniden denenir; taslaktan toplantıya dönülür', async () => {
    const r = await room();
    const m = (await t.api<Meeting>('POST', `/api/rooms/${r.id}/meetings`)).body;
    expect(m.status).toBe('active');
    await say(r.id, 'Elle başlatılan toplantı');
    t.engine.completer = () => 'anlamadım';
    await call(r.id, m.id, 'end');
    await written();
    let [now] = await meetings(r.id);
    expect(now).toMatchObject({
      status: 'failed',
      error: 'Model tutanağı okunabilir bir biçimde yazmadı. Yeniden dene.',
    });

    t.engine.completer = () => minutes();
    expect((await call(r.id, m.id, 'retry')).body.status).toBe('writing');
    await written();
    [now] = await meetings(r.id);
    expect(now!.status).toBe('draft');
    expect((await call(r.id, m.id, 'resume')).body).toMatchObject({
      status: 'active',
      minutes: null,
      endedAt: null,
    });
    // An answer at the wrong step is refused.
    expect((await call(r.id, m.id, 'answer', { answer: 'yes' })).status).toBe(409);
  });

  it('uzun toplantı parça parça okunur, sonra birleştirilir', async () => {
    const r = await room();
    const m = (await t.api<Meeting>('POST', `/api/rooms/${r.id}/meetings`)).body;
    // Lines written straight into the room, so no bot answers them.
    for (let i = 0; i < 60; i++) {
      await t.services.threads.addMessage({
        threadId: r.id,
        role: 'user',
        author: 'user',
        text: `${i}. madde ${'x'.repeat(1400)}`,
      });
    }
    t.engine.completer = (req) =>
      req.user.includes('<parts>') ? minutes({ title: 'Birleşik' }) : minutes({ title: 'Parça' });
    await call(r.id, m.id, 'end');
    await written();
    const parts = t.engine.completions.filter((c) => c.user.includes('<meeting>'));
    expect(parts.length).toBe(3);
    expect(parts[0]!.system).toContain('3 parçanın 1. parçası');
    expect(t.engine.completions.at(-1)!.user).toContain('<parts>');
    expect((await meetings(r.id))[0]!.minutes!.title).toBe('Birleşik');
  });

  it('onaylanan tutanak seçilen botlara not olarak gider; işi üstlenenin işi en başta', async () => {
    const r = await room();
    const m = (await t.api<Meeting>('POST', `/api/rooms/${r.id}/meetings`)).body;
    await say(r.id, 'Konuşalım');
    t.engine.completer = () => minutes();
    await call(r.id, m.id, 'end');
    await written();
    const draft = (await meetings(r.id))[0]!.minutes!;
    const approved: MeetingMinutes = { ...draft, decisions: [...draft.decisions, 'Bütçe 10 bin'] };
    const cem = await t.bot({ name: 'Cem', memory: false });
    const saved = await call(r.id, m.id, 'save', { minutes: approved, botIds: [ada.id, bora.id, cem.id] });
    expect(saved.status).toBe(200);
    expect(saved.body.status).toBe('saved');
    expect(saved.body.minutes).toEqual(approved);
    // A bot without memory keeps no notes.
    expect(saved.body.sentTo).toEqual([
      { botId: ada.id, waiting: false },
      { botId: bora.id, waiting: false },
    ]);
    const notes = (await t.api<Memory[]>('GET', '/api/memory')).body;
    const forAda = notes.find((n) => n.botId === ada.id)!;
    expect(forAda).toMatchObject({ scope: 'bot', source: 'user', threadId: r.id });
    expect(forAda.content.split('\n\n')[1]).toBe(
      'Senin üstlendiğin işler:\n- Basın bültenini yaz (son gün 2026-11-25)',
    );
    expect(forAda.content).toContain('- Bütçe 10 bin');
    const forBora = notes.find((n) => n.botId === bora.id)!;
    expect(forBora.content).not.toContain('Senin üstlendiğin');
    expect(forBora.content).toContain('Diğer işler:\n- Ada: Basın bültenini yaz');
    // Saved once: it is not sent again.
    expect((await call(r.id, m.id, 'save', { minutes: approved, botIds: [ada.id] })).status).toBe(409);
  });

  it('yalnızca konuşabildiği botun notu sahibinin onayını bekler; başkası odanın tutanaklarını göremez', async () => {
    await t.api('PUT', `/api/bots/${ada.id}/access`, { everyone: 'chat', people: {} });
    const ayse = await t.person('ayse');
    const r = await ayse.api<Room>('POST', '/api/rooms', { title: 'Ayşe', botIds: [ada.id] });
    expect(r.status).toBe(200);
    const m = (await ayse.api<Meeting>('POST', `/api/rooms/${r.body.id}/meetings`)).body;
    await ayse.api('POST', `/api/rooms/${r.body.id}/messages`, { clientId: 'c-ayse-0001', text: 'Plan' });
    await t.services.turns.idle();
    t.engine.completer = () => minutes();
    await ayse.api('POST', `/api/rooms/${r.body.id}/meetings/${m.id}/end`);
    await written();
    const draft = (await ayse.api<Meeting[]>('GET', `/api/rooms/${r.body.id}/meetings`)).body[0]!;
    const saved = await ayse.api<Meeting>('POST', `/api/rooms/${r.body.id}/meetings/${m.id}/save`, {
      minutes: draft.minutes,
      botIds: [ada.id],
    });
    expect(saved.body.sentTo).toEqual([{ botId: ada.id, waiting: true }]);
    const waiting = (await t.api<MemoryChange[]>('GET', '/api/memory-changes')).body;
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ botId: ada.id, origin: { kind: 'person' } });

    const ali = await t.person('ali');
    expect((await ali.api('GET', `/api/rooms/${r.body.id}/meetings`)).status).toBeGreaterThanOrEqual(403);
    expect(
      (await ali.api('POST', `/api/rooms/${r.body.id}/meetings/${m.id}/end`)).status,
    ).toBeGreaterThanOrEqual(403);
  });

  it('modelin cevabı hoşgörüyle okunur', () => {
    expect(parseMinutes('yok')).toBe(null);
    expect(
      parseMinutes('{"title": 3, "decisions": ["a", 2, ""], "tasks": [{"text": "x"}, {"owner": "y"}]}'),
    ).toEqual({
      title: '',
      summary: '',
      decisions: ['a'],
      tasks: [{ text: 'x', owner: '', due: null }],
      questions: [],
    });
  });

  it('bota giden not sınırı aşmaz ve botun kendi işiyle başlar', () => {
    const tr = translator('tr');
    const long: MeetingMinutes = {
      title: 'Uzun',
      summary: 'ö'.repeat(5000),
      decisions: ['Karar'],
      tasks: [{ text: 'Benim işim', owner: 'Ada', botId: 'a1', due: null }],
      questions: [],
    };
    const note = meetingNote(long, { id: 'a1', name: 'Ada' }, { t: tr, day: '2026-11-19', room: 'Oda' });
    expect(note.length).toBeLessThanOrEqual(2000);
    expect(
      note.startsWith(
        'Toplantı tutanağı: Uzun (2026-11-19, “Oda” odası)\n\nSenin üstlendiğin işler:\n- Benim işim',
      ),
    ).toBe(true);
  });
});
