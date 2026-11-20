import { createServer as httpServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  SLACK_BOT_SCOPES,
  type Approval,
  type Bot,
  type Routine,
  type RoutineRun,
  type SlackLink,
  type SlackStatus,
  type Thread,
} from '@yumakbot/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { slackMessages } from '../src/channels/format';
import { holdRequest } from '../src/channels/common';
import { namedBot, slackText } from '../src/channels/slack';
import { eq } from 'drizzle-orm';
import { schema } from '../src/db';
import { testServer, waitFor, type Person, type TestServer } from './helpers';

// Made-up tokens in Slack's shapes, put together here so no token-shaped text sits in the source.
const APP = ['xapp', '1', 'A0001', '1234567890', 'abcdefabcdefabcdef'].join('-');
const BOT = ['xoxb', '1234567890', '1234567890', 'abcdefabcdefabcd'].join('-');
const BOT_USER = 'UBOT';
const NAMES: Record<string, string> = { UAYSE: 'ayse.s', UMERT: 'mert.k', UYABAN: 'yabanci', UBOT: 'Yumak' };

interface Call {
  method: string;
  body: Record<string, string>;
}

/** Slack's Web API and a Socket Mode connection, enough for one app; calls are recorded. */
async function fakeSlack() {
  const calls: Call[] = [];
  const acks: string[] = [];
  const replies = new Map<string, Record<string, unknown>[]>();
  let ts = 1000;
  let socket: WebSocket | null = null;
  let envelope = 1;
  // Knobs a test turns: "slow down" answers left to give, refused posts, a refused token.
  let limited = 0;
  let refusePosts = false;
  let tokenError: string | null = null;
  let scopes: string | null = null;
  const read = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString();
  };
  const server: Server = httpServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const body = Object.fromEntries(new URLSearchParams(await read(req)));
      const reply = (x: Record<string, unknown>) =>
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, ...x }));
      if (url.pathname === '/upload') return reply({});
      if (url.pathname === '/missing') return void res.writeHead(404).end();
      const method = url.pathname.replace(/^\/api\//, '');
      const auth = req.headers.authorization;
      const wanted = method === 'apps.connections.open' ? APP : BOT;
      if (auth !== `Bearer ${wanted}`) {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":false,"error":"invalid_auth"}');
        return;
      }
      calls.push({ method, body });
      if (tokenError && method !== 'apps.connections.open') {
        return void res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ok: false, error: tokenError }));
      }
      if (method === 'chat.postMessage' && limited > 0) {
        limited--;
        return void res.writeHead(429, { 'retry-after': '1' }).end('{}');
      }
      if (method === 'chat.postMessage' && refusePosts) {
        return void res
          .writeHead(200, { 'content-type': 'application/json' })
          .end('{"ok":false,"error":"channel_not_found"}');
      }
      if (method === 'apps.connections.open') return reply({ url: `${wsBase}/socket` });
      if (method === 'auth.test') {
        if (scopes !== null) res.setHeader('x-oauth-scopes', scopes);
        return reply({ team_id: 'T1', team: 'Günay', user_id: BOT_USER });
      }
      if (method === 'users.info')
        return reply({ user: { profile: { display_name: NAMES[body.user!] ?? '' } } });
      if (method === 'chat.postMessage') return reply({ ts: String(ts++) });
      if (method === 'conversations.replies') {
        // Pages from the thread's start, as Slack does.
        const all = replies.get(body.ts!) ?? [];
        const from = Number(body.cursor ?? 0);
        const to = from + Number(body.limit ?? 100);
        const more = to < all.length;
        return reply({
          messages: all.slice(from, to),
          has_more: more,
          response_metadata: { next_cursor: more ? String(to) : '' },
        });
      }
      if (method === 'files.getUploadURLExternal')
        return reply({ upload_url: `${base}/upload`, file_id: 'F1' });
      return reply({});
    })();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const wsBase = `ws://127.0.0.1:${port}`;
  const wss = new WebSocketServer({ server, path: '/socket' });
  wss.on('connection', (ws) => {
    socket = ws;
    ws.on('message', (data) => acks.push((JSON.parse(String(data)) as { envelope_id: string }).envelope_id));
    ws.send(JSON.stringify({ type: 'hello', num_connections: 1 }));
  });
  const send = async (type: string, payload: Record<string, unknown>) => {
    await waitFor(async () => socket);
    const id = `e${envelope++}`;
    socket!.send(JSON.stringify({ type, envelope_id: id, payload }));
    await waitFor(async () => acks.includes(id));
  };
  return {
    base: `${base}/api`,
    calls,
    replies,
    /** A message someone writes, as the Events API hands it over; its `ts`. */
    async write(
      user: string,
      text: string,
      where: {
        channel: string;
        type?: 'im' | 'channel';
        thread?: string;
        mention?: boolean;
        files?: Record<string, unknown>[];
      },
    ) {
      const at = String(ts++);
      const event = {
        type: 'message',
        channel: where.channel,
        channel_type: where.type ?? 'channel',
        user,
        text,
        ts: at,
        ...(where.thread && { thread_ts: where.thread }),
        ...(where.files && { files: where.files, subtype: 'file_share' }),
      };
      await send('events_api', { event_id: `Ev${at}`, event });
      // A mention comes once more, as its own event.
      if (where.mention)
        await send('events_api', { event_id: `Ev${at}m`, event: { ...event, type: 'app_mention' } });
      return at;
    },
    /** A reaction someone adds to a message, as the Events API hands it over. */
    async react(user: string, reaction: string, channel: string, messageTs: string) {
      const at = String(ts++);
      await send('events_api', {
        event_id: `Ev${at}r`,
        event: {
          type: 'reaction_added',
          user,
          reaction,
          item: { type: 'message', channel, ts: messageTs },
          event_ts: at,
        },
      });
    },
    async press(user: string, value: string, channel: string, message: { ts: string; thread?: string }) {
      await send('interactive', {
        type: 'block_actions',
        user: { id: user },
        channel: { id: channel },
        message: { ts: message.ts, text: 'kart', thread_ts: message.thread },
        actions: [{ action_id: value, value }],
      });
    },
    limit: (n: number) => (limited = n),
    refuse: (on: boolean) => (refusePosts = on),
    revoke: (code: string | null) => (tokenError = code),
    scopes: (list: string | null) => (scopes = list),
    root: base,
    sent: (method = 'chat.postMessage') => calls.filter((c) => c.method === method),
    close: async () => {
      for (const c of wss.clients) c.terminate();
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

describe('Slack metni', () => {
  it('etiketleri ad, bağlantıları adres yapar; botun kendi etiketi düşer', () => {
    const names = new Map([['UAYSE', 'ayse.s']]);
    expect(
      slackText('<@UBOT> <@UAYSE> bak: <https://a.example/x|rapor> &lt;3 <!channel>', 'UBOT', names),
    ).toBe('@ayse.s bak: rapor (https://a.example/x) <3 @channel');
  });

  it('mesajın başındaki bot adını bulur; en uzun ad kazanır', () => {
    const bots = [{ name: 'Satış' }, { name: 'Satış Ekibi' }];
    expect(namedBot('satış ekibi: rapor', bots)).toEqual({ bot: bots[1], rest: 'rapor' });
    expect(namedBot('Satış, merhaba', bots)).toEqual({ bot: bots[0], rest: 'merhaba' });
    expect(namedBot('Satışlar nasıl', bots)).toBeNull();
  });

  it('yazılan kaçırılır; kimse etiketlenemez', () => {
    const [m] = slackMessages('**Özet** <!channel> & <@U1> [link](https://a.example)');
    expect(m).toBe('*Özet* &lt;!channel&gt; &amp; &lt;@U1&gt; <https://a.example|link>');
  });
});

describe('Slack', () => {
  let t: TestServer;
  let slack: Awaited<ReturnType<typeof fakeSlack>>;
  let ayse: Person;
  let mert: Person;
  afterEach(async () => {
    await t?.dispose();
    await slack?.close();
  });

  const setUp = async () => {
    slack = await fakeSlack();
    t = await testServer({ slackApi: slack.base });
    ayse = await t.person('ayse');
    mert = await t.person('mert');
    const bot = await t.bot({ name: 'Ortak' });
    await t.api<Bot>('PUT', `/api/bots/${bot.id}/access`, { everyone: 'chat', people: {} });
    expect(
      (await ayse.api('PUT', '/api/slack', { appToken: APP, botToken: BOT, botId: bot.id })).status,
    ).toBe(403);
    const r = await t.api<SlackStatus>('PUT', '/api/slack', { appToken: APP, botToken: BOT, botId: bot.id });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ connected: true, workspace: { id: 'T1', name: 'Günay' }, botId: bot.id });
    return bot;
  };
  const link = async (p: Person, slackUser: string) => {
    const { code } = (await p.api<SlackLink>('POST', '/api/slack/me/code')).body;
    await slack.write(slackUser, `link ${code}`, { channel: `D${slackUser}`, type: 'im' });
    await waitFor(async () => (await p.api<SlackLink>('GET', '/api/slack/me')).body.linked);
    // The "you're linked" line is sent after the link is saved: waited for here, so a test that
    // then turns a knob on the next post is not answered by this one.
    await waitFor(async () =>
      slack.sent().find((c) => c.body.channel === `D${slackUser}` && c.body.text?.includes('Bağlandın')),
    );
  };
  const posted = (channel: string, has: string) =>
    waitFor(async () => slack.sent().find((c) => c.body.channel === channel && c.body.text?.includes(has)));

  it('bağlı olmayan kişinin isteği çalışmaz; kodla bağlanan kişi kendi konuşmasında konuşur', async () => {
    const bot = await setUp();
    await slack.write('UAYSE', 'merhaba', { channel: 'DUAYSE', type: 'im' });
    await posted('DUAYSE', 'link KOD');
    expect(t.engine.requests).toHaveLength(0);

    // A wrong code links no one.
    await slack.write('UAYSE', 'link ABCDEFGH23', { channel: 'DUAYSE', type: 'im' });
    await posted('DUAYSE', 'geçersiz');
    await link(ayse, 'UAYSE');
    expect((await ayse.api<SlackLink>('GET', '/api/slack/me')).body.linked).toEqual({ name: 'ayse.s' });

    const at = await slack.write('UAYSE', 'bugün ne var', { channel: 'DUAYSE', type: 'im' });
    await posted('DUAYSE', 'Yankı');
    const own = (await ayse.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    expect(t.engine.requests.at(-1)!.threadId).toBe(own.id);
    await waitFor(async () =>
      slack.sent('reactions.add').find((c) => c.body.timestamp === at && c.body.name === 'white_check_mark'),
    );
    expect(slack.sent('reactions.add').some((c) => c.body.timestamp === at && c.body.name === 'eyes')).toBe(
      true,
    );
  });

  it('yanlış kodu çok deneyen hesap bir süre dinlenmez', async () => {
    await setUp();
    for (let i = 0; i < 5; i++) {
      await slack.write('UYABAN', `link WRONGCODE${i}`, { channel: 'DUYABAN', type: 'im' });
    }
    const { code } = (await ayse.api<SlackLink>('POST', '/api/slack/me/code')).body;
    expect(code).toMatch(/^[A-Z2-9]{10}$/);
    await slack.write('UYABAN', `link ${code}`, { channel: 'DUYABAN', type: 'im' });
    await posted('DUYABAN', '15 dakika');
    expect((await ayse.api<SlackLink>('GET', '/api/slack/me')).body.linked).toBeNull();
  });

  it('kanalda etiketlenince ekip konuşması açar; thread devamı etiketsiz de gelir', async () => {
    const bot = await setUp();
    await link(ayse, 'UAYSE');
    await link(mert, 'UMERT');
    // Not mentioned and not in a thread of the bot: not for it.
    await slack.write('UAYSE', 'herkese merhaba', { channel: 'C1' });
    const top = await slack.write('UAYSE', `<@${BOT_USER}> haftalık özet`, { channel: 'C1', mention: true });
    await posted('C1', 'Yankı');
    const reply = slack.sent().find((c) => c.body.channel === 'C1')!;
    expect(reply.body.thread_ts).toBe(top);
    // Counted once though Slack sent it twice.
    expect(t.engine.requests).toHaveLength(1);
    const team = (await mert.api<Thread[]>('GET', `/api/bots/${bot.id}/threads`)).body.find(
      (x) => x.kind === 'team',
    )!;
    expect(team.title).toBe('haftalık özet');

    await slack.write('UMERT', 'bir de satışlar', { channel: 'C1', thread: top });
    await waitFor(async () => t.engine.requests.length === 2);
    expect(t.engine.requests.at(-1)!.threadId).toBe(team.id);
    expect(t.engine.requests.at(-1)!.prompt).toContain('mert: bir de satışlar');
    // A line addressed to someone else is theirs.
    await slack.write('UMERT', '<@UAYSE> sen bak', { channel: 'C1', thread: top });
    await t.services.turns.idle();
    expect(t.engine.requests).toHaveLength(2);

    // A line written in the app goes to the Slack thread too, with who wrote it.
    await ayse.api('POST', `/api/threads/${team.id}/messages`, {
      clientId: 'app-line-1',
      text: 'uygulamadan ek',
    });
    const mirrored = await posted('C1', 'uygulamadan ek');
    expect(mirrored.body.text).toBe('*ayse*: uygulamadan ek');
    expect(mirrored.body.thread_ts).toBe(top);
    await t.services.turns.idle();

    // Someone not linked is told how, only to them.
    await slack.write('UYABAN', `<@${BOT_USER}> selam`, { channel: 'C1', mention: true });
    await waitFor(async () => slack.sent('chat.postEphemeral').find((c) => c.body.user === 'UYABAN'));
    expect(t.engine.requests).toHaveLength(3);
  });

  it("sonradan çağrıldığı thread'in önceki mesajlarını dışarıdan metin olarak okur", async () => {
    await setUp();
    await link(ayse, 'UAYSE');
    slack.replies.set('500', [
      { user: 'UMERT', text: 'Teklif 120 bin dedi', ts: '500' },
      { user: 'UAYSE', text: 'Bence düşük', ts: '501' },
    ]);
    await slack.write('UAYSE', `<@${BOT_USER}> bunu özetle`, { channel: 'C2', thread: '500', mention: true });
    await waitFor(async () => t.engine.requests.length === 1);
    const prompt = t.engine.requests[0]!.prompt;
    expect(prompt).toContain('mert.k: Teklif 120 bin dedi');
    expect(prompt).toContain('ayse.s: Bence düşük');
    expect(prompt.indexOf('Teklif')).toBeLessThan(prompt.indexOf('bunu özetle'));
    await t.services.turns.idle();
    const turn = await t.services.ctx.db.query.turns.findFirst();
    expect(turn?.outside).toBe('forward');
  });

  it("uzun thread'in son mesajlarını okur, ilklerini değil", async () => {
    await setUp();
    await link(ayse, 'UAYSE');
    slack.replies.set(
      '500',
      Array.from({ length: 450 }, (_, i) => ({ user: 'UMERT', text: `satir ${i}`, ts: String(500 + i) })),
    );
    await slack.write('UAYSE', `<@${BOT_USER}> son durum`, { channel: 'C2', thread: '500', mention: true });
    await waitFor(async () => t.engine.requests.length === 1);
    const prompt = t.engine.requests[0]!.prompt;
    expect(prompt).toMatch(/satir 449\b/);
    expect(prompt).toMatch(/satir 420\b/);
    expect(prompt).not.toMatch(/satir 0\b/);
    expect(prompt).not.toMatch(/satir 419\b/);
    await t.services.turns.idle();
  });

  it('kart düğmesine yalnızca soran kişi basar', async () => {
    await setUp();
    await link(ayse, 'UAYSE');
    await link(mert, 'UMERT');
    const call = { questions: [{ question: 'Hangi şehir?', options: ['İstanbul', 'Ankara'] }] };
    const top = await slack.write('UAYSE', `<@${BOT_USER}> [araç:ask_user ${JSON.stringify(call)}]`, {
      channel: 'C3',
      mention: true,
    });
    const card = await waitFor(async () =>
      slack.sent().find((c) => c.body.channel === 'C3' && c.body.blocks),
    );
    const blocks = JSON.parse(card.body.blocks!) as { elements?: { value: string }[] }[];
    const first = blocks[1]!.elements![0]!.value;
    const msg = { ts: '9999', thread: top };
    await slack.press('UMERT', first, 'C3', msg);
    await waitFor(async () => slack.sent('chat.postEphemeral').find((c) => c.body.user === 'UMERT'));
    const pending = (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body;
    expect(pending).toHaveLength(1);
    await slack.press('UAYSE', first, 'C3', msg);
    await waitFor(async () => slack.sent('chat.update').length);
    expect((await t.api<Approval>('GET', `/api/approvals/${pending[0]!.id}`)).body.answer).toBe('İstanbul');
    await t.services.turns.idle();
  });

  it('kimseyle paylaşılmamış bot kanalda cevap vermez', async () => {
    await setUp();
    const mine = await t.bot({ name: 'Benim' });
    const { code } = (await t.api<SlackLink>('POST', '/api/slack/me/code')).body;
    await slack.write('UOWNER', `link ${code}`, { channel: 'DUOWNER', type: 'im' });
    await waitFor(async () => (await t.api<SlackLink>('GET', '/api/slack/me')).body.linked);
    await slack.write('UOWNER', `<@${BOT_USER}> Benim: selam`, { channel: 'C4', mention: true });
    const note = await waitFor(async () =>
      slack.sent('chat.postEphemeral').find((c) => c.body.user === 'UOWNER'),
    );
    expect(note.body.text).toContain('Benim');
    expect(t.engine.requests).toHaveLength(0);
    // In a direct message it answers its owner.
    await slack.write('UOWNER', 'Benim: selam', { channel: 'DUOWNER', type: 'im' });
    await posted('DUOWNER', 'Yankı');
    expect(t.engine.requests.at(-1)!.botId).toBe(mine.id);
  });

  it('Slack kanalı seçili rutin ekip konuşmasında çalışır ve raporunu kanala yazar', async () => {
    const bot = await setUp();
    await t.api('PATCH', '/api/settings', { occupation: 'Sahibin gizli işi' });
    const bad = await t.api('POST', '/api/routines', {
      botId: bot.id,
      name: 'Sabah',
      prompt: 'Gündemi özetle',
      schedule: { type: 'daily', time: '08:00' },
      slackChannel: '#genel',
    });
    expect(bad.status).toBe(400);
    const r = await t.api<{ id: string }>('POST', '/api/routines', {
      botId: bot.id,
      name: 'Sabah',
      prompt: 'Gündemi özetle',
      schedule: { type: 'daily', time: '08:00' },
      slackChannel: 'C0GENEL01',
    });
    expect(r.status).toBe(200);
    await t.api('POST', `/api/routines/${r.body.id}/run`, {});
    const post = await posted('C0GENEL01', 'Sabah');
    expect(post.body.text).toContain('Yankı');
    expect(post.body.thread_ts).toBeUndefined();
    const req = t.engine.requests.at(-1)!;
    expect(req.systemPrompt).not.toContain('Sahibin gizli işi');
    expect((await t.services.threads.row(req.threadId)).kind).toBe('team');
  });

  it('kişinin kendi tepkisi, rutinini tepki verdiği mesajla çalıştırır', async () => {
    const bot = await setUp();
    await t.api('PUT', `/api/bots/${bot.id}/access`, { everyone: 'chat', people: { ayse: 'edit' } });
    await link(ayse, 'UAYSE');
    await link(mert, 'UMERT');
    const r = await ayse.api<Routine>('POST', '/api/routines', {
      botId: bot.id,
      name: 'Şikâyet',
      prompt: 'Bu mesaja bir cevap taslağı yaz',
      schedule: { type: 'daily', time: '08:00' },
      slackReaction: ':Eyes:',
    });
    expect(r.status).toBe(200);
    expect(r.body.slackReaction).toBe('eyes');
    slack.replies.set('1700000000.000100', [
      { ts: '1700000000.000100', user: 'UMUSTERI', text: 'Siparişim hâlâ gelmedi' },
    ]);
    const runs = async () => (await ayse.api<RoutineRun[]>('GET', `/api/routines/${r.body.id}/runs`)).body;
    // Someone else's reaction, or another reaction, starts nothing.
    await slack.react('UMERT', 'eyes', 'C0GENEL01', '1700000000.000100');
    await slack.react('UAYSE', 'thumbsup', 'C0GENEL01', '1700000000.000100');
    await t.services.turns.idle();
    expect(await runs()).toHaveLength(0);

    await slack.react('UAYSE', 'eyes', 'C0GENEL01', '1700000000.000100');
    await waitFor(async () => ((await runs()).length ? true : null));
    await t.services.turns.idle();
    const asked = t.engine.requests.at(-1)!;
    expect(asked.prompt).toContain('Siparişim hâlâ gelmedi');
    // The message is someone else's text: the run reads it as outside text.
    const [run] = await runs();
    const [row] = await t.services.ctx.db
      .select({ trigger: schema.routineRuns.trigger })
      .from(schema.routineRuns)
      .where(eq(schema.routineRuns.id, run!.id));
    expect(row!.trigger).toBe('forward');
    // The same message reacted to again runs it once.
    await slack.react('UAYSE', 'eyes', 'C0GENEL01', '1700000000.000100');
    await t.services.turns.idle();
    expect(await runs()).toHaveLength(1);
  });

  const reacted = (name: string, ts: string) =>
    slack.sent('reactions.add').some((c) => c.body.timestamp === ts && c.body.name === name);

  it('Slack yavaşla (429) deyince bekleyip yeniden dener ve cevap kaybolmaz', async () => {
    await setUp();
    await link(ayse, 'UAYSE');
    slack.limit(1);
    const at = await slack.write('UAYSE', 'merhaba', { channel: 'DUAYSE', type: 'im' });
    await waitFor(async () => (reacted('white_check_mark', at) ? true : null));
    expect(slack.sent().filter((c) => c.body.text?.includes('Yankı'))).toHaveLength(2);
    expect(reacted('x', at)).toBe(false);
  });

  it('gönderilemeyen cevap aynı yere haber verir ve mesaj ✅ almaz', async () => {
    await setUp();
    await link(ayse, 'UAYSE');
    slack.refuse(true);
    const at = await slack.write('UAYSE', 'merhaba', { channel: 'DUAYSE', type: 'im' });
    await waitFor(async () => (reacted('x', at) ? true : null));
    await posted('DUAYSE', 'iletilemedi');
    expect(reacted('white_check_mark', at)).toBe(false);
  });

  it('rutin raporu Slack reddedince report() false döner', async () => {
    await setUp();
    expect(await t.services.slack.report('C0RAPOR01', 'Sabah', 'özet')).toBe(true);
    slack.refuse(true);
    expect(await t.services.slack.report('C0RAPOR01', 'Sabah', 'özet')).toBe(false);
  });

  it('yeniden başlarken yarım kalan istek temizlenir: 👀 gider, kesildiği söylenir, kayıt silinir', async () => {
    const bot = await setUp();
    const own = (await ayse.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    const [row] = await t.services.ctx.db.select().from(schema.channels);
    await holdRequest(t.services.ctx, row!.id, own.id, { channel: 'C7', threadTs: '700', ts: '701' });
    await t.services.slack.settleHeld(row!);
    const note = await posted('C7', 'yarıda');
    expect(note.body.thread_ts).toBe('700');
    expect(
      slack.sent('reactions.remove').some((c) => c.body.timestamp === '701' && c.body.name === 'eyes'),
    ).toBe(true);
    expect(reacted('x', '701')).toBe(true);
    expect(await t.services.ctx.db.select().from(schema.channelRequests)).toHaveLength(0);
  });

  it('bot anahtarı iptal edilince durum hata gösterir, anahtar çalışınca hata gider', async () => {
    await setUp();
    await link(ayse, 'UAYSE');
    slack.revoke('token_revoked');
    await slack.write('UAYSE', 'merhaba', { channel: 'DUAYSE', type: 'im' });
    const bad = await waitFor(async () => {
      const r = (await t.api<SlackStatus>('GET', '/api/slack')).body;
      return r.error ? r : null;
    });
    expect(bad.error).toContain('token_revoked');
    slack.revoke(null);
    await slack.write('UAYSE', 'bir daha', { channel: 'DUAYSE', type: 'im' });
    await waitFor(async () => ((await t.api<SlackStatus>('GET', '/api/slack')).body.error ? null : true));
  });

  it("bağlı thread'de son isteğinden beri yazılan, başkasına giden satırlar bota gelir", async () => {
    await setUp();
    await link(ayse, 'UAYSE');
    const top = await slack.write('UAYSE', `<@${BOT_USER}> özetle`, { channel: 'C5', mention: true });
    await waitFor(async () => t.engine.requests.length === 1);
    await t.services.turns.idle();
    slack.replies.set(top, [
      { user: 'UAYSE', text: 'özetle', ts: top },
      { user: 'UMERT', text: '<@UAYSE> şuna da bak', ts: `${top}.5` },
    ]);
    await slack.write('UMERT', '<@UAYSE> şuna da bak', { channel: 'C5', thread: top });
    await slack.write('UAYSE', 'ne dersin', { channel: 'C5', thread: top });
    await waitFor(async () => t.engine.requests.length === 2);
    const prompt = t.engine.requests[1]!.prompt;
    expect(prompt).toContain('mert.k: @ayse.s şuna da bak');
    expect(prompt.indexOf('şuna da bak')).toBeLessThan(prompt.indexOf('ne dersin'));
    await t.services.turns.idle();
  });

  it('alınamayan dosya bota da söylenir', async () => {
    await setUp();
    await link(ayse, 'UAYSE');
    await slack.write('UAYSE', 'bu dosyaya bak', {
      channel: 'DUAYSE',
      type: 'im',
      files: [{ id: 'F9', name: 'rapor.pdf', size: 10, url_private_download: `${slack.root}/missing` }],
    });
    await waitFor(async () => t.engine.requests.length === 1);
    const prompt = t.engine.requests[0]!.prompt;
    expect(prompt).toContain('bu dosyaya bak');
    expect(prompt).toContain('rapor.pdf');
    expect(prompt).toContain('Ulaşmayan');
    await t.services.turns.idle();
  });

  it('bağlanırken eksik izinler durumda uyarı olarak görünür', async () => {
    slack = await fakeSlack();
    slack.scopes('chat:write,users:read');
    t = await testServer({ slackApi: slack.base });
    const r = await t.api<SlackStatus>('PUT', '/api/slack', { appToken: APP, botToken: BOT, botId: null });
    expect(r.status).toBe(200);
    expect(r.body.error).toContain('reactions:write');
    expect(r.body.error).not.toContain('chat:write');
  });

  it('an app without reactions:read works on, and says what that leaves off', async () => {
    slack = await fakeSlack();
    slack.scopes(SLACK_BOT_SCOPES.join(','));
    t = await testServer({ slackApi: slack.base });
    const r = await t.api<SlackStatus>('PUT', '/api/slack', { appToken: APP, botToken: BOT, botId: null });
    expect(r.status).toBe(200);
    expect(r.body.error).toBeNull();
    expect(r.body.optionalMissing).toEqual(['reactions:read']);
    // A person setting up a routine is told too, not only whoever looks after the Slack app.
    expect((await t.api<SlackLink>('GET', '/api/slack/me')).body.optionalMissing).toEqual(['reactions:read']);

    // Once the app has it, nothing is said.
    slack.scopes([...SLACK_BOT_SCOPES, 'reactions:read'].join(','));
    const again = await t.api<SlackStatus>('PUT', '/api/slack', {
      appToken: APP,
      botToken: BOT,
      botId: null,
    });
    expect(again.body.optionalMissing).toEqual([]);
  });
});
