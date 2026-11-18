import { createServer as httpServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { discordToken, type Approval, type Bot, type DiscordStatus, type Thread } from '@yumakbot/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { discordText } from '../src/channels/discord';
import { discordMessages } from '../src/channels/format';
import { redactSecrets } from '../src/services/secrets';
import { testServer, waitFor, type TestServer } from './helpers';

// A made-up token in Discord's shape, put together here so no token-shaped text sits in the source.
const TOKEN = ['MTIzNDU2Nzg5MDEyMzQ1Njc4OQ', 'GaBcDe', 'abcdefghijklmnopqrstuvwxyz0123456789ab'].join('.');
const BOT_USER = '900';
const SERVER = '100';
const ROLE = '201';

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

interface Person {
  id: string;
  name: string;
  roles?: string[];
}

const AYSE: Person = { id: '501', name: 'ayse' };
const MERT: Person = { id: '502', name: 'mert' };

/** Discord's REST API and a Gateway connection, enough for one bot; calls are recorded. */
async function fakeDiscord(opts: { refuseContent?: boolean } = {}) {
  const calls: Call[] = [];
  const gateway = { identifies: 0, resumes: 0, intents: [] as number[] };
  const history = new Map<string, Record<string, unknown>[]>();
  let id = 1000;
  let seq = 1;
  let socket: WebSocket | null = null;
  let identified: Record<string, unknown> | null = null;
  const read = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString();
  };
  const server: Server = httpServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const path = url.pathname.replace(/^\/api/, '');
      const raw = await read(req);
      let body: Record<string, unknown> = {};
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        body = { form: raw };
      }
      const reply = (x: unknown, status = 200) =>
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(x));
      if (!path.startsWith('/interactions/') && req.headers.authorization !== `Bot ${TOKEN}`) {
        return reply({ message: '401: Unauthorized', code: 0 }, 401);
      }
      calls.push({ method: req.method!, path: `${path}${url.search}`, body });
      if (path === '/users/@me') return reply({ id: BOT_USER, username: 'Yumak' });
      if (path === '/oauth2/applications/@me') return reply({ id: '777' });
      if (path === '/gateway/bot') return reply({ url: `${wsBase}/gateway` });
      if (path === '/users/@me/guilds') return reply([{ id: SERVER, name: 'Topluluk' }]);
      if (path === `/guilds/${SERVER}/roles`)
        return reply([
          { id: SERVER, name: '@everyone', position: 0 },
          { id: ROLE, name: 'Müşteri', position: 1 },
          { id: '202', name: 'Başka bot', position: 2, managed: true },
        ]);
      const history_ = /^\/channels\/(\w+)\/messages$/.exec(path);
      if (history_ && req.method === 'GET') return reply(history.get(history_[1]!) ?? []);
      if (history_ && req.method === 'POST') return reply({ id: String(id++) });
      if (req.method === 'PATCH') return reply({ id: 'x' });
      res.writeHead(204).end();
    })();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const wsBase = `ws://127.0.0.1:${port}`;
  const wss = new WebSocketServer({ server, path: '/gateway' });
  wss.on('connection', (ws) => {
    socket = ws;
    ws.on('message', (data) => {
      const f = JSON.parse(String(data)) as { op: number; d: Record<string, unknown> };
      if (f.op === 6) {
        gateway.resumes++;
        ws.send(JSON.stringify({ op: 0, t: 'RESUMED', s: seq++, d: {} }));
      }
      if (f.op === 2) {
        gateway.identifies++;
        gateway.intents.push(Number(f.d.intents));
        // Not allowed the text of every message in the developer portal.
        if (opts.refuseContent && Number(f.d.intents) & (1 << 15)) {
          ws.close(4014, 'Disallowed intent(s)');
          return;
        }
        identified = f.d;
        ws.send(
          JSON.stringify({
            op: 0,
            t: 'READY',
            s: seq++,
            d: {
              session_id: 's1',
              resume_gateway_url: `${wsBase}/gateway`,
              user: { id: BOT_USER, username: 'Yumak' },
            },
          }),
        );
      }
      if (f.op === 1) ws.send(JSON.stringify({ op: 11 }));
    });
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));
  });
  const dispatch = async (t: string, d: Record<string, unknown>) => {
    await waitFor(async () => socket && identified);
    socket!.send(JSON.stringify({ op: 0, t, s: seq++, d }));
  };
  return {
    base: `${base}/api`,
    calls,
    history,
    identified: () => identified,
    gateway,
    /** Discord asks the bot to connect again. */
    reconnect: () => socket?.send(JSON.stringify({ op: 7, d: null })),
    /** A message someone writes in a channel; its id. */
    async write(
      who: Person,
      text: string,
      where: {
        channel?: string;
        mention?: boolean;
        replyTo?: { id: string; author: string; root?: string };
        dm?: boolean;
      } = {},
    ) {
      const at = String(id++);
      await dispatch('MESSAGE_CREATE', {
        id: at,
        channel_id: where.channel ?? 'C1',
        ...(!where.dm && { guild_id: SERVER, member: { roles: who.roles ?? [] } }),
        author: { id: who.id, username: who.name },
        content: where.mention === false ? text : `<@${BOT_USER}> ${text}`,
        mentions: where.mention === false ? [] : [{ id: BOT_USER, username: 'Yumak', bot: true }],
        type: where.replyTo ? 19 : 0,
        timestamp: new Date().toISOString(),
        ...(where.replyTo && {
          message_reference: { message_id: where.replyTo.id },
          referenced_message: {
            id: where.replyTo.id,
            channel_id: where.channel ?? 'C1',
            author: {
              id: where.replyTo.author,
              username: 'x',
              ...(where.replyTo.author === BOT_USER && { bot: true }),
            },
            content: 'önceki',
            ...(where.replyTo.root && { message_reference: { message_id: where.replyTo.root } }),
          },
        }),
      });
      return at;
    },
    async press(who: Person, customId: string, message = { id: '1', content: 'kart' }) {
      const iid = `i${id++}`;
      await dispatch('INTERACTION_CREATE', {
        id: iid,
        token: 'tok',
        type: 3,
        guild_id: SERVER,
        channel_id: 'C1',
        member: { user: { id: who.id, username: who.name }, roles: who.roles ?? [] },
        message,
        data: { custom_id: customId },
      });
      return waitFor(async () => calls.find((c) => c.path.startsWith(`/interactions/${iid}/`)));
    },
    posts: (channel = 'C1') =>
      calls.filter((c) => c.method === 'POST' && c.path === `/channels/${channel}/messages`),
    edits: () => calls.filter((c) => c.method === 'PATCH'),
    reactions: (message: string) =>
      calls
        .filter((c) => c.method === 'PUT' && c.path.startsWith(`/channels/C1/messages/${message}/reactions/`))
        .map((c) => decodeURIComponent(c.path.split('/')[6]!)),
    close: async () => {
      for (const c of wss.clients) c.terminate();
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

describe('Discord metni', () => {
  it('botun etiketi düşer, başkalarınınki ad olur', () => {
    expect(
      discordText(`<@${BOT_USER}> <@!501> bak <#77> <:yay:123>`, BOT_USER, [{ id: '501', name: 'ayse' }]),
    ).toBe('@ayse bak #77 :yay:');
  });

  it('uzun cevap 2000 karakteri aşmayan parçalara bölünür; tablo listeye döner', () => {
    const parts = discordMessages(
      Array.from({ length: 80 }, (_, i) => `satır ${i} ${'x'.repeat(40)}`).join('\n\n'),
    );
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(2000);
    expect(discordMessages('| Ad | Yaş |\n| --- | --- |\n| Ali | 3 |')[0]).toBe('**Ali**\nYaş: 3');
  });

  it('bot anahtarı tanınır ve metinden silinir', () => {
    expect(discordToken(`Bot ${TOKEN}`)).toBe(TOKEN);
    expect(discordToken('merhaba')).toBeNull();
    expect(redactSecrets(`anahtar: ${TOKEN}`, '[gizli]').text).toBe('anahtar: [gizli]');
  });
});

describe('Discord', () => {
  let t: TestServer;
  let discord: Awaited<ReturnType<typeof fakeDiscord>>;
  afterEach(async () => {
    await t?.dispose();
    await discord?.close();
  });

  const setUp = async () => {
    discord = await fakeDiscord();
    t = await testServer({ discordApi: discord.base });
    const member = await t.person('ayse');
    const bot = await t.bot({ name: 'Destek' });
    await t.api<Bot>('PUT', `/api/bots/${bot.id}/access`, { everyone: 'chat', people: {} });
    expect((await member.api('PUT', '/api/discord', { token: TOKEN, botId: bot.id })).status).toBe(403);
    const r = await t.api<DiscordStatus>('PUT', '/api/discord', { token: TOKEN, botId: bot.id });
    expect(r.status).toBe(200);
    await waitFor(async () => discord.identified());
    return bot;
  };
  const answered = (has: string) =>
    waitFor(async () =>
      [...discord.posts(), ...discord.edits()].find((c) => String(c.body.content ?? '').includes(has)),
    );

  it('kurulum sunucuları ve rollerini gösterir; anahtar hiçbir yerde görünmez', async () => {
    const bot = await setUp();
    const status = (await t.api<DiscordStatus>('GET', '/api/discord')).body;
    expect(status).toMatchObject({
      connected: true,
      botUser: 'Yumak',
      botId: bot.id,
      servers: [{ id: SERVER, name: 'Topluluk', roles: [{ id: ROLE, name: 'Müşteri' }], allowed: [] }],
    });
    expect(status.inviteUrl).toContain('client_id=777');
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    // The Gateway is asked for the text of every message.
    expect(Number(discord.identified()!.intents) & (1 << 15)).toBeTruthy();
    const bad = await t.api('PUT', '/api/discord', { token: 'yanlis', botId: bot.id });
    expect(bad.status).toBe(400);
  });

  it('etiketlenince takım konuşması açar, cevabı zincirde verir; bota cevap aynı konuşmada sürer', async () => {
    const bot = await setUp();
    // Not mentioned: not for it.
    await discord.write(AYSE, 'herkese selam', { mention: false });
    const first = await discord.write(AYSE, 'siparişim nerede');
    const answer = await answered('Yankı');
    // The answer takes the place of "Working on it…", which replies to the first message.
    const status = discord.posts().find((c) => String(c.body.content).includes('çalışıyorum'))!;
    expect(status.body.message_reference).toMatchObject({ message_id: first });
    expect(status.body.allowed_mentions).toEqual({ parse: ['users'], replied_user: false });
    expect(answer.method).toBe('PATCH');
    const team = (await t.api<Thread[]>('GET', `/api/bots/${bot.id}/threads`)).body.find(
      (x) => x.kind === 'team',
    )!;
    expect(team.title).toBe('siparişim nerede');
    expect(t.engine.requests).toHaveLength(1);
    expect(t.engine.requests[0]!.prompt).toContain('ayse: siparişim nerede');
    await waitFor(async () => discord.reactions(first).includes('✅'));
    expect(discord.reactions(first)).toContain('👀');

    // A reply to the bot's post names the first message, and goes on there.
    await discord.write(MERT, 'benimki de', { replyTo: { id: '9999', author: BOT_USER, root: first } });
    await waitFor(async () => t.engine.requests.length === 2);
    expect(t.engine.requests[1]!.threadId).toBe(team.id);
    expect(t.engine.requests[1]!.prompt).toContain('mert: benimki de');
    await t.services.turns.idle();

    // Its turns act with no more than talking with the bot, and every change needs a card.
    const turns = await t.services.ctx.db.query.turns.findMany();
    expect(turns.every((x) => x.guest && x.modeCap === 'ask')).toBe(true);
  });

  it('yeni konuşma kanalın son mesajlarını dışarıdan metin olarak okur', async () => {
    await setUp();
    discord.history.set('C2', [
      {
        id: '3',
        author: { id: '503', username: 'zeynep' },
        content: 'Ekran görüntüsü bu',
        timestamp: new Date().toISOString(),
      },
      {
        id: '2',
        author: { id: '503', username: 'zeynep' },
        content: 'çok eski',
        timestamp: new Date(Date.now() - 60 * 60_000).toISOString(),
      },
    ]);
    await discord.write(AYSE, 'bunu kayda geç', { channel: 'C2' });
    await waitFor(async () => t.engine.requests.length === 1);
    const prompt = t.engine.requests[0]!.prompt;
    expect(prompt).toContain('zeynep: Ekran görüntüsü bu');
    expect(prompt).not.toContain('çok eski');
    await t.services.turns.idle();
    const turn = await t.services.ctx.db.query.turns.findFirst();
    expect(turn?.outside).toBe('forward');
  });

  it('seçili rol dışındakine cevap vermez; doğrudan mesaja sabit cevap verir', async () => {
    await setUp();
    const r = await t.api<DiscordStatus>('PATCH', '/api/discord', {
      roles: { serverId: SERVER, roleIds: [ROLE, '999'] },
    });
    expect(r.body.servers[0]!.allowed).toEqual([ROLE]);
    await discord.write(AYSE, 'merhaba');
    await discord.write({ ...MERT, roles: [ROLE] }, 'iade nasıl olur');
    await waitFor(async () => t.engine.requests.length === 1);
    expect(t.engine.requests[0]!.prompt).toContain('iade nasıl olur');
    await t.services.turns.idle();
    expect(t.engine.requests).toHaveLength(1);

    await discord.write(AYSE, 'selam', { dm: true, channel: 'D1' });
    await waitFor(async () => discord.posts('D1').find((c) => String(c.body.content).includes('etiketle')));
  });

  it('kart düğmesine yalnızca isteği yazan basar; "hep izin ver" sunulmaz', async () => {
    await setUp();
    const call = { questions: [{ question: 'Hangi şehir?', options: ['İstanbul', 'Ankara'] }] };
    await discord.write(AYSE, `[araç:ask_user ${JSON.stringify(call)}]`);
    const card = await waitFor(async () =>
      [...discord.posts(), ...discord.edits()].find((c) => String(c.body.content).includes('Hangi şehir')),
    );
    const rows = card.body.components as { components: { custom_id: string; label: string }[] }[];
    const first = rows[0]!.components[0]!.custom_id;
    const other = await discord.press(MERT, first);
    expect(other.body).toMatchObject({ type: 4, data: { flags: 64 } });
    const pending = (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body;
    expect(pending).toHaveLength(1);
    // "Always allow" never comes from Discord, even typed by hand.
    await discord.press(AYSE, `a:${pending[0]!.id}:r`);
    const mine = await discord.press(AYSE, first);
    expect(mine.body).toEqual({ type: 6 });
    await waitFor(async () => (await t.api<Approval>('GET', `/api/approvals/${pending[0]!.id}`)).body.answer);
    expect((await t.api<Approval>('GET', `/api/approvals/${pending[0]!.id}`)).body.answer).toBe('İstanbul');
    await t.services.turns.idle();
  });

  it('kimseyle paylaşılmamış bot Discord’da cevap vermez', async () => {
    const shared = await setUp();
    const mine = await t.bot({ name: 'Benim' });
    await t.api('PATCH', '/api/discord', { botId: mine.id });
    await discord.write(AYSE, 'selam');
    await answered('Benim');
    expect(t.engine.requests).toHaveLength(0);
    await t.api('PATCH', '/api/discord', { botId: shared.id });
  });

  it('herkesin yazabildiği sunucuda adım kartı uygulamada cevaplanır; rol listesi varsa soran basar', async () => {
    const bot = await setUp();
    // Even a bot that works without asking asks for a stranger's step.
    await t.api('PATCH', `/api/bots/${bot.id}`, { permissionMode: 'auto' });
    await discord.write(AYSE, '[izin:Bash {"command":"touch rapor.txt"}]');
    const card = await waitFor(async () =>
      [...discord.posts(), ...discord.edits()].find((c) => String(c.body.content).includes('uygulamasında')),
    );
    expect((card.body.components as unknown[] | undefined) ?? []).toHaveLength(0);
    const pending = (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body;
    expect(pending).toHaveLength(1);
    const refused = await discord.press(AYSE, `a:${pending[0]!.id}:y`);
    expect(refused.body).toMatchObject({ type: 4, data: { flags: 64 } });
    expect((await t.api<Approval>('GET', `/api/approvals/${pending[0]!.id}`)).body.status).toBe('pending');
    await t.api('POST', `/api/approvals/${pending[0]!.id}`, { decision: 'deny' });
    await t.services.turns.idle();

    // With a role list, the member who asked presses the card's buttons in Discord.
    await t.api('PATCH', '/api/discord', { roles: { serverId: SERVER, roleIds: [ROLE] } });
    const member = { ...AYSE, roles: [ROLE] };
    await discord.write(member, '[izin:Bash {"command":"touch ozet.txt"}]', { channel: 'C1' });
    const withButtons = await waitFor(async () =>
      [...discord.posts(), ...discord.edits()].find((c) =>
        JSON.stringify(c.body.components ?? []).includes('"custom_id":"a:'),
      ),
    );
    const rows = withButtons.body.components as { components: { custom_id: string }[] }[];
    const ids = rows.flatMap((r) => r.components.map((b) => b.custom_id));
    expect(ids.some((x) => x.endsWith(':r'))).toBe(false);
    const allow = ids.find((x) => x.endsWith(':y'))!;
    expect((await discord.press({ ...MERT, roles: [ROLE] }, allow)).body).toMatchObject({ type: 4 });
    expect((await discord.press(member, allow)).body).toEqual({ type: 6 });
    const id = allow.split(':')[1]!;
    await waitFor(
      async () => (await t.api<Approval>('GET', `/api/approvals/${id}`)).body.status === 'allowed',
    );
    await t.services.turns.idle();
  });

  it('isteği yalnızca yazan durdurur', async () => {
    await setUp();
    const first = await discord.write(AYSE, '[uzun-araç:10000]');
    await waitFor(async () => (await t.services.ctx.db.query.turns.findFirst())?.status === 'running');
    const reply = { id: '9999', author: BOT_USER, root: first };
    await discord.write(MERT, 'stop', { replyTo: reply });
    await answered('isteği yazan');
    expect((await t.services.ctx.db.query.turns.findFirst())?.status).toBe('running');
    await discord.write(AYSE, 'stop', { replyTo: reply });
    await waitFor(async () => discord.reactions(first).includes('⏹️'));
    expect(t.engine.requests).toHaveLength(1);
  });

  it('Discord yeniden bağlan deyince oturum sürer', async () => {
    await setUp();
    discord.reconnect();
    await waitFor(async () => discord.gateway.resumes === 1);
    expect(discord.gateway.identifies).toBe(1);
  });

  it('her mesajın metnine izin yoksa onsuz bağlanır ve bunu gösterir', async () => {
    discord = await fakeDiscord({ refuseContent: true });
    t = await testServer({ discordApi: discord.base });
    await t.api('PUT', '/api/discord', { token: TOKEN, botId: null });
    await waitFor(async () => discord.identified());
    expect(discord.gateway.intents.map((x) => !!(x & (1 << 15)))).toEqual([true, false]);
    await waitFor(async () => !(await t.api<DiscordStatus>('GET', '/api/discord')).body.messageContent);
  });
});
