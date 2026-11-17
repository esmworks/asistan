import type { SearchHit, Thread } from '@yumakbot/shared';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { openText, sealText, setSealing } from '../src/db/sealed';
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
    expect((await t.services.memory.search([], 'yılmaz')).map((m) => m.content)).toEqual([
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
    expect(openText('yb1:bozuk:veri:x')).toBe('');
  });
});
