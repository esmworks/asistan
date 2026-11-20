import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { createServer as httpServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Approval, Bot, Message, TeamsLink, TeamsStatus } from '@yumakbot/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { TEAMS_PATH } from '../src/channels/teams';
import { TeamsAuth, teamsParts, teamsText, type TeamsActivity } from '../src/channels/teams-api';
import { testServer, waitFor, type Person, type TestServer } from './helpers';

const APP_ID = '11111111-2222-4333-8444-555555555555';
const TENANT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER_TENANT = 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee';
// Put together here so no secret-shaped text sits in the source.
const SECRET = ['test', 'client', 'secret', '42'].join('-');
const ISSUER = 'https://api.botframework.com';

const keyPair = () => generateKeyPairSync('rsa', { modulusLength: 2048 });

/** Microsoft's sign-in service, the Bot Framework's keys and a Bot Connector, enough for one bot. */
async function fakeMicrosoft(signing: { publicKey: KeyObject }, endorsements: string[] | null = ['msteams']) {
  const posts: { conversation: string; auth: string | undefined; body: Record<string, unknown> }[] = [];
  let keyReads = 0;
  const read = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString();
  };
  const server: Server = httpServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const send = (status: number, x: unknown) =>
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(x));
      if (url.pathname === '/openid') return send(200, { jwks_uri: `${base}/keys` });
      if (url.pathname === '/keys') {
        keyReads++;
        const jwk = signing.publicKey.export({ format: 'jwk' });
        return send(200, {
          keys: [{ ...jwk, kid: 'k1', use: 'sig', ...(endorsements && { endorsements }) }],
        });
      }
      if (url.pathname === `/${TENANT}/oauth2/v2.0/token`) {
        const form = new URLSearchParams(await read(req));
        if (form.get('client_secret') !== SECRET || form.get('client_id') !== APP_ID)
          return send(401, { error: 'invalid_client' });
        expect(form.get('scope')).toBe('https://api.botframework.com/.default');
        return send(200, { access_token: 'connector-token', expires_in: 3600 });
      }
      const m = /^\/svc\/v3\/conversations\/([^/]+)\/activities$/.exec(url.pathname);
      if (m && req.method === 'POST') {
        posts.push({
          conversation: decodeURIComponent(m[1]!),
          auth: req.headers.authorization,
          body: JSON.parse(await read(req)) as Record<string, unknown>,
        });
        return send(201, { id: String(posts.length) });
      }
      send(404, {});
    })();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    serviceUrl: `${base}/svc/`,
    posts,
    keyReads: () => keyReads,
    texts: (conversation: string) =>
      posts.filter((p) => p.conversation === conversation && p.body.type === 'message'),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const enc = (x: unknown) => Buffer.from(JSON.stringify(x)).toString('base64url');

/** A token the way the Bot Framework signs one; `claims` and `head` change what a test needs. */
function token(
  privateKey: KeyObject,
  serviceUrl: string,
  claims: Record<string, unknown> = {},
  head: Record<string, unknown> = {},
) {
  const now = Math.floor(Date.now() / 1000);
  const h = enc({ alg: 'RS256', typ: 'JWT', kid: 'k1', ...head });
  const p = enc({
    iss: ISSUER,
    aud: APP_ID,
    serviceurl: serviceUrl,
    nbf: now - 10,
    exp: now + 3600,
    ...claims,
  });
  const sig = sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url');
  return `Bearer ${h}.${p}.${sig}`;
}

describe('Teams sign-in check', () => {
  let ms: Awaited<ReturnType<typeof fakeMicrosoft>>;
  afterEach(() => ms?.close());

  it('believes only a token the Bot Framework signed for this bot and this service', async () => {
    const keys = keyPair();
    ms = await fakeMicrosoft(keys);
    const auth = new TeamsAuth(`${ms.base}/openid`);
    const activity: TeamsActivity = { channelId: 'msteams', serviceUrl: ms.serviceUrl };
    const good = token(keys.privateKey, ms.serviceUrl);
    expect(await auth.check(good, activity, APP_ID)).toBe(true);
    // Read once and kept.
    expect(await auth.check(good, activity, APP_ID)).toBe(true);
    expect(ms.keyReads()).toBe(1);

    const now = Math.floor(Date.now() / 1000);
    const refused = [
      undefined,
      'Bearer not.a.token',
      token(keys.privateKey, ms.serviceUrl, { aud: '99999999-2222-4333-8444-555555555555' }),
      token(keys.privateKey, ms.serviceUrl, { iss: 'https://sts.windows.net/x/' }),
      token(keys.privateKey, ms.serviceUrl, { exp: now - 3600 }),
      token(keys.privateKey, ms.serviceUrl, { nbf: now + 3600 }),
      token(keys.privateKey, 'https://evil.example.com/'),
      token(keys.privateKey, ms.serviceUrl, {}, { alg: 'none' }),
      token(keys.privateKey, ms.serviceUrl, {}, { kid: 'unknown' }),
      // Signed with a key the Bot Framework does not list.
      token(keyPair().privateKey, ms.serviceUrl),
    ];
    for (const header of refused) expect(await auth.check(header, activity, APP_ID)).toBe(false);
    // The token names one service; a message naming another is not believed.
    expect(await auth.check(good, { ...activity, serviceUrl: 'https://evil.example.com/' }, APP_ID)).toBe(
      false,
    );
    // A key endorsed for Teams does not sign for another channel.
    expect(await auth.check(good, { ...activity, channelId: 'webchat' }, APP_ID)).toBe(false);
  });

  it('reads Teams text as plain words and splits long replies', () => {
    expect(teamsText('<at>Yumak</at> merhaba&nbsp;<b>dünya</b> &amp; &lt;siz&gt;')).toBe(
      'merhaba dünya & <siz>',
    );
    expect(teamsText('<p>bir</p><p>iki</p>')).toBe('bir\niki');
    const long = `${'a'.repeat(15_000)}\n${'b'.repeat(15_000)}`;
    const parts = teamsParts(long);
    expect(parts).toHaveLength(2);
    expect(parts.join('\n')).toBe(long);
  });
});

describe('Teams channel', () => {
  let t: TestServer;
  let ms: Awaited<ReturnType<typeof fakeMicrosoft>>;
  let keys: ReturnType<typeof keyPair>;
  let ayse: Person;
  let n = 0;
  afterEach(async () => {
    await t?.dispose();
    await ms?.close();
  });

  const setUp = async (publicUrl: string | null = null) => {
    keys = keyPair();
    ms = await fakeMicrosoft(keys);
    t = await testServer({ teamsLogin: ms.base, teamsOpenId: `${ms.base}/openid`, publicUrl });
    ayse = await t.person('ayse');
    const bot = await t.bot({ name: 'Ortak' });
    await t.api<Bot>('PUT', `/api/bots/${bot.id}/access`, { everyone: 'chat', people: {} });
    const body = { appId: APP_ID, tenantId: TENANT, secret: SECRET, botId: bot.id };
    expect((await ayse.api('PUT', '/api/teams', body)).status).toBe(403);
    expect((await t.api('PUT', '/api/teams', { ...body, secret: 'wrong' })).status).toBe(400);
    const r = await t.api<TeamsStatus>('PUT', '/api/teams', body);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ connected: true, appId: APP_ID, tenantId: TENANT, botId: bot.id });
    return bot;
  };

  /** A message as Teams delivers it, signed unless `auth` says otherwise. */
  const deliver = async (
    from: string,
    text: string,
    opts: { auth?: string | null; tenant?: string; type?: string; value?: unknown } = {},
  ) => {
    const activity = {
      type: 'message',
      id: `m${++n}`,
      channelId: 'msteams',
      serviceUrl: ms.serviceUrl,
      from: { id: from, name: from === '29:ayse' ? 'Ayşe S.' : from },
      recipient: { id: '28:bot', name: 'Yumak' },
      conversation: {
        id: `a:${from}`,
        conversationType: opts.type ?? 'personal',
        tenantId: opts.tenant ?? TENANT,
      },
      text,
      ...(opts.value !== undefined && { value: opts.value }),
    };
    const headers: Record<string, string> = { host: 'localhost', 'content-type': 'application/json' };
    const auth = opts.auth === undefined ? token(keys.privateKey, ms.serviceUrl) : opts.auth;
    if (auth) headers.authorization = auth;
    const res = await t.app.inject({ method: 'POST', url: TEAMS_PATH, headers, payload: activity });
    await t.services.teams.idle();
    return res.statusCode;
  };
  const said = (from: string, has: string) =>
    waitFor(async () => ms.texts(`a:${from}`).find((p) => String(p.body.text ?? '').includes(has)));

  it('needs a public HTTPS address to show the endpoint', async () => {
    await setUp('https://yumak.example.com');
    const s = (await t.api<TeamsStatus>('GET', '/api/teams')).body;
    expect(s.endpoint).toBe(`https://yumak.example.com${TEAMS_PATH}`);
  });

  it('reads only signed requests; a linked person talks to the bot and hears its reply', async () => {
    const bot = await setUp();
    expect((await t.api<TeamsStatus>('GET', '/api/teams')).body.endpoint).toBeNull();
    // Unsigned or badly signed: refused before anything is read.
    expect(await deliver('29:ayse', 'merhaba', { auth: null })).toBe(401);
    expect(await deliver('29:ayse', 'merhaba', { auth: token(keyPair().privateKey, ms.serviceUrl) })).toBe(
      403,
    );
    expect(ms.posts).toHaveLength(0);

    // Someone not linked is told how to link, and nothing runs.
    expect(await deliver('29:ayse', 'merhaba')).toBe(200);
    await said('29:ayse', 'link KOD');
    expect(t.engine.requests).toHaveLength(0);

    // A wrong code links no one; the person's own code does.
    await deliver('29:ayse', 'link ABCDEFGH23');
    await said('29:ayse', 'geçersiz');
    const { code } = (await ayse.api<TeamsLink>('POST', '/api/teams/me/code')).body;
    expect(code).toMatch(/^[A-Z2-9]{10}$/);
    await deliver('29:ayse', `<at>Yumak</at> link ${code}`);
    await said('29:ayse', 'Bağlandın, Ayşe S.');
    expect((await ayse.api<TeamsLink>('GET', '/api/teams/me')).body).toMatchObject({
      linked: { name: 'Ayşe S.' },
      code: null,
    });
    expect((await t.api<TeamsStatus>('GET', '/api/teams')).body.people).toEqual([
      expect.objectContaining({ teamsName: 'Ayşe S.' }),
    ]);

    // Now a message is the person's own, in their conversation with the bot; the reply goes back.
    await deliver('29:ayse', 'Teams’ten selam');
    await t.services.turns.idle();
    const thread = await t.services.threads.main(bot.id, ayse.id);
    const msgs = (await ayse.api<Message[]>('GET', `/api/threads/${thread.id}/messages`)).body;
    const mine = msgs.find((m) => m.role === 'user');
    expect(mine).toMatchObject({ text: 'Teams’ten selam', props: { via: 'teams' } });
    const reply = await waitFor(async () =>
      ms.texts('a:29:ayse').find((p) => p.body.textFormat === 'markdown'),
    );
    expect(reply.auth).toBe('Bearer connector-token');
    expect(msgs.some((m) => m.role === 'assistant' && m.text === reply.body.text)).toBe(true);
  });

  it('answers only its own directory, and only in a personal chat', async () => {
    await setUp();
    const { code } = (await ayse.api<TeamsLink>('POST', '/api/teams/me/code')).body;
    await deliver('29:ayse', `link ${code}`, { tenant: OTHER_TENANT });
    expect(ms.posts).toHaveLength(0);
    expect((await ayse.api<TeamsLink>('GET', '/api/teams/me')).body.linked).toBeNull();
    await deliver('29:ayse', 'selam', { type: 'channel' });
    await said('29:ayse', 'birebir');
    expect(t.engine.requests).toHaveLength(0);
  });

  it('sends a step card with buttons, and a press answers it as the person', async () => {
    await setUp();
    const { code } = (await ayse.api<TeamsLink>('POST', '/api/teams/me/code')).body;
    await deliver('29:ayse', `link ${code}`);
    await said('29:ayse', 'Bağlandın');
    const call = { questions: [{ question: 'Hangi şehir?', options: ['İstanbul', 'Ankara'] }] };
    await deliver('29:ayse', `[araç:ask_user ${JSON.stringify(call)}]`);
    const card = await waitFor(async () =>
      ms.texts('a:29:ayse').find((p) => Array.isArray(p.body.attachments)),
    );
    const content = (card.body.attachments as { content: { actions: { data: { choice: string } }[] } }[])[0]!
      .content;
    expect(content.actions).toHaveLength(2);
    const pending = (await ayse.api<Approval[]>('GET', '/api/approvals?status=pending')).body;
    expect(pending).toHaveLength(1);
    // Someone who is not linked cannot press it.
    await deliver('29:mert', '', { value: { choice: content.actions[0]!.data.choice } });
    await said('29:mert', 'link KOD');
    await deliver('29:ayse', '', { value: { choice: content.actions[0]!.data.choice } });
    await said('29:ayse', '✓ İstanbul');
    expect((await ayse.api<Approval>('GET', `/api/approvals/${pending[0]!.id}`)).body.answer).toBe(
      'İstanbul',
    );
    await t.services.turns.idle();
  });

  it('unlinking stops the person being read, and disconnecting stops the address', async () => {
    await setUp();
    const { code } = (await ayse.api<TeamsLink>('POST', '/api/teams/me/code')).body;
    await deliver('29:ayse', `link ${code}`);
    await said('29:ayse', 'Bağlandın');
    await ayse.api('DELETE', '/api/teams/me');
    await deliver('29:ayse', 'selam');
    await said('29:ayse', 'link KOD');
    expect(t.engine.requests).toHaveLength(0);
    await t.api('DELETE', '/api/teams');
    expect((await t.api<TeamsStatus>('GET', '/api/teams')).body.connected).toBe(false);
    expect(await deliver('29:ayse', 'selam')).toBe(404);
  });
});
