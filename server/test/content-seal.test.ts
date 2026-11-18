import type { SearchHit, Thread } from '@yumakbot/shared';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OWNER_ID } from '../src/users';
import { schema } from '../src/db';
import { openText, sealText, setContentKey, setSealing } from '../src/db/sealed';
import { sealWith } from '../src/crypto';
import { randomBytes } from 'node:crypto';
import { AUTH } from './helpers';
import { testServer, type TestServer } from './helpers';

describe('içeriğin veritabanında şifrelenmesi', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(async () => {
    setSealing(false);
    await t.dispose();
  });

  /** What the database holds, as stored: not opened by the column type. */
  const stored = async () => ({
    messages: (await t.db.db.select({ v: sql<string>`${schema.messages.text}` }).from(schema.messages)).map(
      (r) => r.v,
    ),
    memories: (
      await t.db.db.select({ v: sql<string>`${schema.memories.content}` }).from(schema.memories)
    ).map((r) => r.v),
    prompts: (await t.db.db.select({ v: sql<string>`${schema.turns.prompt}` }).from(schema.turns)).map(
      (r) => r.v,
    ),
  });

  it('açılınca var olan içerik şifrelenir; uygulama ve arama eskisi gibi çalışır; kapanınca geri döner', async () => {
    const bot = await t.bot();
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await t.send(thread.id, 'Pasaport numaram TR-998877');
    await t.services.turns.idle();
    await t.services.memory.create({
      scope: 'user',
      botId: null,
      content: 'Doktorum Dr. Yılmaz',
      source: 'user',
    });
    expect((await stored()).messages.join(' ')).toContain('TR-998877');

    const on = await t.api<{ on: boolean }>('PUT', '/api/content-encryption', { on: true });
    expect(on.body.on).toBe(true);
    await t.services.contentSeal.settled();
    const sealed = await stored();
    expect(JSON.stringify(sealed)).not.toContain('TR-998877');
    expect(JSON.stringify(sealed)).not.toContain('Yılmaz');
    expect(sealed.messages.filter(Boolean).every((v) => v.startsWith('yb1:'))).toBe(true);
    expect((await t.api<{ pending: number }>('GET', '/api/content-encryption')).body.pending).toBe(0);

    // Read back in the clear, found by search.
    expect((await t.messages(thread.id)).map((m) => m.text)).toContain('Pasaport numaram TR-998877');
    const hits = (await t.api<SearchHit[]>('GET', `/api/search?q=${encodeURIComponent('numaram tr')}`)).body;
    expect(hits.map((h) => h.excerpt).join(' ')).toContain('TR-998877');
    expect((await t.services.memory.search([], OWNER_ID, 'yılmaz')).map((m) => m.content)).toEqual([
      'Doktorum Dr. Yılmaz',
    ]);

    // New content is sealed as it is written.
    await t.send(thread.id, 'Yeni gizli not 42');
    await t.services.turns.idle();
    expect(JSON.stringify(await stored())).not.toContain('Yeni gizli not 42');

    await t.api('PUT', '/api/content-encryption', { on: false });
    await t.services.contentSeal.settled();
    const plain = await stored();
    expect(plain.messages.join(' ')).toContain('Yeni gizli not 42');
    expect(plain.memories).toEqual(['Doktorum Dr. Yılmaz']);
    expect(plain.prompts.some((p) => p.startsWith('yb1:'))).toBe(false);
  });

  it('başka anahtarla şifrelenmiş değer okunamaz ama hata vermez; şifresiz değer olduğu gibi okunur', () => {
    setSealing(true);
    const v = sealText('merhaba');
    expect(v.startsWith('yb1:')).toBe(true);
    expect(openText(v)).toBe('merhaba');
    expect(openText('düz metin')).toBe('düz metin');
    // Only the exact sealed shape is taken for sealed: anything else is plain text.
    expect(openText('yb1:bozuk:veri:x')).toBe('yb1:bozuk:veri:x');
    expect(openText(`yb1:${'A'.repeat(16)}:${'B'.repeat(22)}==:QUJD`)).toBe('');
  });

  it('yb1: ile başlayan düz metin şifreli sanılmaz; açılıp kapanınca bozulmaz', async () => {
    const bot = await t.bot();
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await t.send(thread.id, 'yb1:abc bir not');
    await t.services.turns.idle();
    const texts = async () => (await t.messages(thread.id)).map((m) => m.text);
    expect(await texts()).toContain('yb1:abc bir not');
    await t.api('PUT', '/api/content-encryption', { on: true });
    await t.services.contentSeal.settled();
    expect((await stored()).messages.every((v) => /^yb1:[A-Za-z0-9+/]{16}:/.test(v))).toBe(true);
    await t.api('PUT', '/api/content-encryption', { on: false });
    await t.services.contentSeal.settled();
    expect((await stored()).messages).toContain('yb1:abc bir not');
    expect(await texts()).toContain('yb1:abc bir not');
  });

  it('başka anahtarla şifrelenmiş değerin üzerine yazılmaz; açılamayan olarak sayılır', async () => {
    const other = `yb1:${sealWith(randomBytes(32), 'başka sunucunun notu')}`;
    await t.services.memory.create({ scope: 'user', botId: null, content: 'geçici', source: 'user' });
    await t.db.db.execute(sql`update memories set content = ${other}`);
    expect((await t.services.memory.list())[0]!.content).toBe('');
    // Off with a sealed row left: the conversion runs, and must not write it over.
    await t.api('PUT', '/api/content-encryption', { on: false });
    await t.services.contentSeal.settled();
    expect((await stored()).memories).toEqual([other]);
    const status = (await t.api<{ unreadable: number; pending: number }>('GET', '/api/content-encryption'))
      .body;
    expect(status).toMatchObject({ unreadable: 1, pending: 1 });
  });

  it('dönüşüm sürerken anahtar değişirse baştan bir tur daha atılır', async () => {
    const bot = await t.bot();
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    for (let i = 0; i < 5; i++) await t.send(thread.id, `Mesaj ${i}`);
    await t.services.turns.idle();
    await t.services.contentSeal.set(true);
    await t.services.contentSeal.set(false);
    await t.services.contentSeal.settled();
    const raw = await stored();
    expect([...raw.messages, ...raw.prompts].some((v) => v.startsWith('yb1:'))).toBe(false);
    expect((await t.api<{ pending: number }>('GET', '/api/content-encryption')).body.pending).toBe(0);
  });

  it('başlıklar, mesaj eklerindeki içerik ve hafıza geçmişi de şifrelenir', async () => {
    const bot = await t.bot();
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await t.send(thread.id, 'Kızımın okulu Ankara Koleji');
    await t.services.turns.idle();
    const first = (await t.messages(thread.id)).find((m) => m.text.includes('Ankara Koleji'))!;
    await t.services.inbox.send(thread.id, { text: 'Bunu hatırla', replyTo: first.id });
    await t.services.turns.idle();
    const note = await t.services.memory.create({
      scope: 'user',
      botId: null,
      content: 'Kan grubum AB+',
      source: 'user',
    });
    await t.services.memory.update(note.id, { content: 'Kan grubum AB Rh+' }, 'user');
    await t.api('PUT', '/api/content-encryption', { on: true });
    await t.services.contentSeal.settled();
    const dump = JSON.stringify([
      await t.db.db.select({ v: sql<string>`${schema.messages.props}::text` }).from(schema.messages),
      await t.db.db.select({ v: sql<string>`${schema.threads.title}` }).from(schema.threads),
      await t.db.db
        .select({
          b: sql<string>`${schema.auditLog.before}::text`,
          a: sql<string>`${schema.auditLog.after}::text`,
        })
        .from(schema.auditLog),
    ]);
    expect(dump).not.toContain('Ankara Koleji');
    expect(dump).not.toContain('Kan grubum');
    // Read back as before.
    const reply = (await t.messages(thread.id)).find((m) => m.text === 'Bunu hatırla')!;
    expect(JSON.stringify(reply.props.replyTo)).toContain('Ankara Koleji');
    expect((await t.services.memory.history()).map((h) => h.after)).toContain('Kan grubum AB Rh+');
  });

  it('şifreleme açıkken geri yüklenen satırlar eski anahtarla şifrelenmez', async () => {
    const bot = await t.bot({ name: 'Yedekli' });
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await t.send(thread.id, 'Yedekteki gizli cümle');
    await t.services.turns.idle();
    await t.api('PUT', '/api/content-encryption', { on: true });
    await t.services.contentSeal.settled();
    const made = await t.api<{ id: string }>('POST', '/api/backup', { password: 'yedek-sifresi-123' });
    const file = (await t.app.inject({ method: 'GET', url: `/api/backup/${made.body.id}`, headers: AUTH }))
      .rawPayload;

    // Another server, with its own key and sealing on, takes the backup in.
    const other = await testServer();
    try {
      await other.api('PUT', '/api/content-encryption', { on: true });
      const res = await other.app.inject({
        method: 'POST',
        url: '/api/backup/restore',
        headers: {
          ...AUTH,
          'content-type': 'application/octet-stream',
          'x-backup-password': encodeURIComponent('yedek-sifresi-123'),
        },
        payload: file,
      });
      expect(res.statusCode).toBe(200);
      const raw = await other.db.db.select({ v: sql<string>`${schema.messages.text}` }).from(schema.messages);
      // In plain, for the restart to seal with the restored key.
      expect(raw.map((r) => r.v)).toContain('Yedekteki gizli cümle');
    } finally {
      await other.dispose();
      setContentKey(t.services.vault.contentKey());
    }
  });
});
