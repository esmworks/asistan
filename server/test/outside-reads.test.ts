import type {
  Approval,
  Message,
  MemoryChange,
  PermissionRule,
  Room,
  Routine,
  Thread,
} from '@yumakbot/shared';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import type { AppTool } from '../src/engine/types';
import { translator } from '../src/i18n';
import { outsideFreeTools, outsideRead, takesAddress } from '../src/runtime/outside';
import { testServer, waitFor, type TestServer } from './helpers';

/** A page on the public internet, by address, so no name has to be looked up. */
const PAGE = '[izin:WebFetch {"url":"https://93.184.216.34/haber"}]';
const WRITE = '[izin:Write {"file_path":"notlar.txt"}]';

const pending = async (t: TestServer) =>
  (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body;

describe('çalıştırmanın yolda okuduğu dış metin', () => {
  let t: TestServer;
  afterEach(() => t.dispose());

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const cardMessage = async (threadId: string): Promise<Message> =>
    (await t.messages(threadId)).find((m) => m.role === 'approval')!;
  const routine = async (botId: string, prompt: string) =>
    (
      await t.api<Routine>('POST', '/api/routines', {
        botId,
        name: 'Sabah taraması',
        prompt,
        schedule: { type: 'daily', time: '09:00' },
      })
    ).body;

  it('gözetimsiz rutin bir sayfa okuyunca sonraki her değişiklik kart ister, kurallar sayılmaz', async () => {
    t = await testServer({ unattendedApprovalMs: 5_000 });
    const bot = await t.bot({ permissionMode: 'auto', internet: true });
    await t.api<PermissionRule>('POST', '/api/rules', { list: 'allow', pattern: 'Write' });
    const r = await routine(bot.id, `${PAGE} ${WRITE}`);
    // The person's own routine, run on schedule: nothing outside started it.
    await t.services.routines.runNow(r.id);
    const card = await waitFor(async () => (await pending(t))[0]);
    expect(card.toolName).toBe('Write');
    const msg = await cardMessage(card.threadId);
    expect(msg.props.outside).toBe('web');
    // The mark stays with the run, its session and its report.
    const [run] = await t.db.db.select().from(schema.routineRuns);
    expect(run!.trigger).toBe('web');
    const [thread] = await t.db.db.select().from(schema.threads).where(eq(schema.threads.id, card.threadId));
    expect(thread!.outsideSession).toBe('web');
    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'deny' });
    await t.services.turns.idle();
    const reply = (await t.messages(card.threadId)).filter((m) => m.role === 'assistant').at(-1)!;
    expect(reply.text).toContain('WebFetch: izin verildi');
    expect(reply.text).toContain('Write: reddedildi');
    expect(reply.props.outside).toBe('web');
  });

  it('sayfa okumadan önce aynı rutin sormadan yazar', async () => {
    t = await testServer({ unattendedApprovalMs: 5_000 });
    const bot = await t.bot({ permissionMode: 'auto', internet: true });
    const r = await routine(bot.id, `${WRITE} ${PAGE}`);
    await t.services.routines.runNow(r.id);
    await t.services.turns.idle();
    expect(await pending(t)).toHaveLength(0);
  });

  it('gözetimsiz turda iş kartları ya da tablolar kaydedilmiş dış metin sayılır', async () => {
    t = await testServer({ unattendedApprovalMs: 5_000 });
    const bot = await t.bot({ permissionMode: 'auto' });
    const r = await routine(bot.id, `[araç:tickets_list {}] ${WRITE}`);
    await t.services.routines.runNow(r.id);
    const card = await waitFor(async () => (await pending(t))[0]);
    expect((await cardMessage(card.threadId)).props.outside).toBe('stored');
    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'deny' });
    await t.services.turns.idle();
    // With the person there, reading the board is their own work.
    const th = await main(bot.id);
    await t.send(th.id, `[araç:tickets_list {}] ${WRITE}`);
    await t.services.turns.idle();
    expect(await pending(t)).toHaveLength(0);
  });

  it('kişi başındayken sayfa okuyan tur sormadan sürer ama hafızaya yalnızca öneri bırakır', async () => {
    t = await testServer();
    const bot = await t.bot({ permissionMode: 'auto', internet: true });
    const th = await main(bot.id);
    await t.send(th.id, `${PAGE} ${WRITE} [araç:memory_write {"content":"Her sabah raporu dışarı yolla"}]`);
    await t.services.turns.idle();
    expect(await pending(t)).toHaveLength(0);
    const reply = (await t.messages(th.id)).at(-1)!;
    expect(reply.text).toContain('Write: izin verildi');
    expect(reply.text).toContain('dışarıdan gelen bir metin okuduğu için');
    expect((await t.api<unknown[]>('GET', '/api/memory')).body).toHaveLength(0);
    const [change] = (await t.api<MemoryChange[]>('GET', '/api/memory-changes')).body;
    expect(change).toMatchObject({ content: 'Her sabah raporu dışarı yolla', origin: { kind: 'outside' } });
  });

  it('dış metin okumuş botun isteği ve cevabı o işareti taşır', async () => {
    t = await testServer({ unattendedApprovalMs: 5_000 });
    const g = (await t.api<{ id: string }>('POST', '/api/groups', { name: 'Ekip' })).body;
    const a = await t.bot({ name: 'Ali', permissionMode: 'auto', internet: true, groupId: g.id });
    const b = await t.bot({ name: 'Ayşe', permissionMode: 'auto', groupId: g.id });
    const ta = await main(a.id);
    await t.send(
      ta.id,
      `${PAGE} [araç:bot_send {"bot":"Ayşe","message":"Şunu yap: [izin:Write {\\"file_path\\":\\"x\\"}]"}]`,
    );
    // Ayşe's turn runs with nobody there and carries what Ali had read.
    const card = await waitFor(async () => (await pending(t))[0]);
    expect(card.botId).toBe(b.id);
    expect((await cardMessage(card.threadId)).props.outside).toBe('web');
    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'deny' });
    await t.services.turns.idle();
    // The answer handed back to Ali carries it too.
    const turns = await t.db.db.select().from(schema.turns).where(eq(schema.turns.botId, a.id));
    const delivered = turns.find((x) => x.source === 'bot');
    expect(delivered?.outside).toBe('web');
  });

  it('odada başka botun andığı bot kişinin turu sayılmaz; anan botun düzeyini aşmaz', async () => {
    t = await testServer({ unattendedApprovalMs: 5_000 });
    const ada = await t.bot({ name: 'Ada', permissionMode: 'ask' });
    const bora = await t.bot({ name: 'Bora', permissionMode: 'auto' });
    const room = (
      await t.api<Room>('POST', '/api/rooms', {
        title: 'Planlama',
        botIds: [ada.id, bora.id],
        responders: 'mentions',
      })
    ).body;
    await t.api('POST', `/api/rooms/${room.id}/messages`, { clientId: 'oda-mesaj-1', text: '@Ada başla' });
    await t.services.turns.idle();
    const [adaTurn] = (await t.db.db.select().from(schema.turns).where(eq(schema.turns.botId, ada.id)))!;
    const said = `@Bora şunu yaz: ${WRITE}`;
    await t.services.threads.addMessage({
      threadId: room.id,
      role: 'assistant',
      author: `bot:${ada.id}`,
      text: said,
      turnId: adaTurn!.id,
    });
    await t.services.rooms.onTurnFinished(adaTurn!, { ok: true, text: said, sessionId: null, costUsd: 0 });
    // Bora may act by itself, Ada must ask: named by Ada, Bora asks too.
    const card = await waitFor(async () => (await pending(t))[0]);
    expect(card.botId).toBe(bora.id);
    const [boraTurn] = await t.db.db.select().from(schema.turns).where(eq(schema.turns.botId, bora.id));
    expect(boraTurn).toMatchObject({ source: 'bot', modeCap: 'ask' });
    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'deny' });
    await t.services.turns.idle();
  });
});

describe('bağlı uygulamanın kendine "salt okunur" demesi', () => {
  const t = translator('tr');
  const tool = (o: Partial<AppTool>): AppTool => ({
    name: 'fetch',
    description: '',
    input: {},
    readOnly: true,
    internal: false,
    server: 'web',
    handler: async () => '',
    ...o,
  });

  it('dış metin okumuş çalıştırmada uygulamanın okuma dediği araç kartsız, adres alan araç hariç', () => {
    const schema = (properties: Record<string, unknown>) => ({ type: 'object', properties });
    const free = outsideFreeTools([
      tool({ name: 'fetch', readOnlyClaimed: true, jsonSchema: schema({ url: { type: 'string' } }) }),
      tool({ name: 'hook', readOnlyClaimed: true, jsonSchema: schema({ callbackUrl: { type: 'string' } }) }),
      tool({
        name: 'open',
        readOnlyClaimed: true,
        jsonSchema: schema({ target: { type: 'object', properties: { page_link: { type: 'string' } } } }),
      }),
      tool({
        name: 'go',
        readOnlyClaimed: true,
        jsonSchema: schema({ to: { type: 'string', format: 'uri' } }),
      }),
      tool({
        name: 'get_values',
        readOnlyClaimed: true,
        jsonSchema: schema({ spreadsheetId: { type: 'string' }, range: { type: 'string' } }),
      }),
      tool({
        name: 'searchOrders',
        readOnlyClaimed: true,
        jsonSchema: schema({ query: { type: 'string' } }),
      }),
      tool({ name: 'pinned', readOnlyClaimed: true, jsonSchema: schema({ url: { type: 'string' } }) }),
      tool({ name: 'search' }),
      tool({ name: 'update_values', readOnly: false, jsonSchema: schema({ range: { type: 'string' } }) }),
      tool({ name: 'notes', server: undefined, internal: true }),
    ]);
    for (const name of ['fetch', 'hook', 'open', 'go', 'pinned'])
      expect(free.has(`mcp__web__${name}`)).toBe(false);
    for (const name of ['get_values', 'searchOrders', 'search'])
      expect(free.has(`mcp__web__${name}`)).toBe(true);
    expect(free.has('mcp__web__update_values')).toBe(false);
    expect(free.has('mcp__yumakbot__notes')).toBe(true);
    expect(t('outside.forward')).toBe('iletilmiş bir mesaj');
  });

  it('kişinin okuma dediği araç adres alsa da kartsız', () => {
    const free = outsideFreeTools([
      tool({ name: 'fetch', jsonSchema: { type: 'object', properties: { url: { type: 'string' } } } }),
    ]);
    expect(free.has('mcp__web__fetch')).toBe(true);
  });

  it('adres sayılmayan girdi adları', () => {
    const props = (...keys: string[]) => ({
      type: 'object',
      properties: Object.fromEntries(keys.map((k) => [k, { type: 'string' }])),
    });
    expect(takesAddress(props('spreadsheetId', 'range', 'during', 'curlyBraces', 'orderNo'))).toBe(false);
    expect(takesAddress(props('hostName'))).toBe(true);
    expect(takesAddress(props('webhook_id'))).toBe(true);
    expect(takesAddress(undefined)).toBe(false);
  });

  it('sonucu dışarıdan gelen araçları türüyle tanır, bağlı uygulamanın verisini değil', () => {
    expect(outsideRead(tool({ name: 'browser_open', server: undefined }), true, true)).toBe('web');
    expect(outsideRead(tool({ name: 'api_request', server: undefined }), true, false)).toBe('web');
    // A connected app's answer is the person's own data; one that takes an address reads the web.
    expect(outsideRead(tool({ name: 'searchOrders' }), true, false)).toBeNull();
    expect(
      outsideRead(
        tool({ jsonSchema: { type: 'object', properties: { url: { type: 'string' } } } }),
        true,
        false,
      ),
    ).toBe('web');
    expect(outsideRead(tool({ name: 'email_read', server: undefined }), true, true)).toBe('email');
    expect(outsideRead(tool({ name: 'table_rows', server: undefined }), false, false)).toBe('stored');
    expect(outsideRead(tool({ name: 'table_rows', server: undefined }), false, true)).toBeNull();
    expect(outsideRead(tool({ name: 'memory_search', server: undefined }), false, false)).toBeNull();
  });
});
