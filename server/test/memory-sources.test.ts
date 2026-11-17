import type { Approval, Memory, MemoryChange, Routine, Thread } from '@yumakbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sourceOf } from '../src/services/memory';
import { sourceAddress } from '../src/tools';
import { testServer, waitFor, type TestServer } from './helpers';

describe('hafıza notunun kaynağı', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const notes = async () => (await t.api<Memory[]>('GET', '/api/memory')).body;

  it('kaynak adresi yalnız http(s) olur; içindeki giriş bilgisi atılır', () => {
    expect(sourceAddress('https://ornek.com/fiyat?x=1')).toBe('https://ornek.com/fiyat?x=1');
    expect(sourceAddress(' https://ad:sifre@ornek.com/a ')).toBe('https://ornek.com/a');
    expect(
      sourceAddress(
        'https://ornek.com/rapor?ay=11&keyword=fiyat&access_token=abc123&X-Amz-Signature=f00&q=sk-ant-0123456789abcdefghijKLMN#id_token=x',
      ),
    ).toBe('https://ornek.com/rapor?ay=11&keyword=fiyat');
    expect(sourceAddress('javascript:alert(1)')).toBeUndefined();
    expect(sourceAddress('ornek.com')).toBeUndefined();
  });

  it('bot notu yazdığı sohbeti ve verdiği sayfayı kaydeder', async () => {
    const a = await t.bot({ name: 'Ali' });
    const th = await main(a.id);
    await t.send(
      th.id,
      '[araç:memory_write {"content":"Ürün 90 TL oldu","from":"https://ornek.com/urun"}] [araç:memory_write {"content":"Kullanıcı çay sever","scope":"user"}]',
    );
    // The shared memory takes the note once the person approves it on its card.
    const card = await waitFor(
      async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body[0],
    );
    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'allow', answer: 'Onayla' });
    await t.services.turns.idle();
    const byText = new Map((await notes()).map((m) => [m.content, m]));
    expect(byText.get('Ürün 90 TL oldu')).toMatchObject({
      threadId: th.id,
      sourceUrl: 'https://ornek.com/urun',
    });
    expect(byText.get('Kullanıcı çay sever')).toMatchObject({ threadId: th.id, sourceUrl: null });
    // The bot sees where its notes came from when it looks them up.
    await t.send(th.id, '[araç:memory_search {"query":"Ürün"}]');
    await t.services.turns.idle();
    expect((await t.messages(th.id)).at(-1)!.text).toContain('https://ornek.com/urun');
  });

  it('web adresi olmayan kaynak not yazdırmaz', async () => {
    const a = await t.bot({ name: 'Ali' });
    const th = await main(a.id);
    await t.send(th.id, '[araç:memory_write {"content":"x","from":"bir dergide okudum"}]');
    await t.services.turns.idle();
    expect(await notes()).toHaveLength(0);
    expect((await t.messages(th.id)).at(-1)!.text).toContain('web adresi değil');
  });

  it('elle düzeltme kaynağı değiştirmez; botun düzeltmesi yeni kaynağı yazar', async () => {
    const a = await t.bot({ name: 'Ali' });
    const th = await main(a.id);
    await t.send(th.id, '[araç:memory_write {"content":"Fiyat 100","from":"https://ornek.com/a"}]');
    await t.services.turns.idle();
    const [note] = await notes();
    await t.api('PATCH', `/api/memory/${note!.id}`, { content: 'Fiyat 100 TL' });
    expect((await notes())[0]).toMatchObject({ content: 'Fiyat 100 TL', sourceUrl: 'https://ornek.com/a' });
    const other = (await t.api<Thread>('POST', `/api/bots/${a.id}/threads`, {})).body;
    await t.send(
      other.id,
      `[araç:memory_update {"id":"${note!.id}","content":"Fiyat 90 TL","from":"https://ornek.com/b"}]`,
    );
    await t.services.turns.idle();
    expect((await notes())[0]).toMatchObject({ threadId: other.id, sourceUrl: 'https://ornek.com/b' });
    // Changed again elsewhere with no page: that conversation is the source now, not page b.
    const third = (await t.api<Thread>('POST', `/api/bots/${a.id}/threads`, {})).body;
    await t.send(third.id, `[araç:memory_update {"id":"${note!.id}","content":"Fiyat 80 TL"}]`);
    await t.services.turns.idle();
    expect((await notes())[0]).toMatchObject({ content: 'Fiyat 80 TL', threadId: third.id, sourceUrl: null });
  });

  it('kaynağı bilinmeyen bir değişiklik eski kaynağı silmez', () => {
    expect(sourceOf({ threadId: null, sourceUrl: null })).toEqual({});
    expect(sourceOf({ threadId: null, sourceUrl: 'https://x.com/' })).toEqual({
      sourceUrl: 'https://x.com/',
    });
    expect(sourceOf({ threadId: 't', sourceUrl: null })).toEqual({ threadId: 't', sourceUrl: null });
  });

  it('kimse izlemezken istenen not onaylanınca kaynağıyla yazılır', async () => {
    const a = await t.bot({ name: 'Ali' });
    const routine = (
      await t.api<Routine>('POST', '/api/routines', {
        botId: a.id,
        name: 'Fiyat',
        prompt: '[araç:memory_write {"content":"Fiyat düştü","scope":"user","from":"https://ornek.com/c"}]',
        schedule: { type: 'weekly', days: [0], time: '18:00' },
      })
    ).body;
    await t.api('POST', `/api/routines/${routine.id}/run`);
    await t.services.turns.idle();
    const [waiting] = (await t.api<MemoryChange[]>('GET', '/api/memory-changes')).body;
    expect(waiting!.sourceUrl).toBe('https://ornek.com/c');
    await t.api('POST', `/api/memory-changes/${waiting!.id}/accept`, {});
    expect((await notes())[0]).toMatchObject({
      content: 'Fiyat düştü',
      threadId: waiting!.threadId,
      sourceUrl: 'https://ornek.com/c',
    });
  });
});
