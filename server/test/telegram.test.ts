import { createServer as httpServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Approval, TelegramStatus, Thread } from '@yumakbot/shared';
import { telegramToken } from '@yumakbot/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { telegramMessages } from '../src/channels/format';
import { schema } from '../src/db';
import { testServer, waitFor, type TestServer } from './helpers';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0';
const PERSON = { id: 4242, is_bot: false, first_name: 'Ayşe', username: 'ayse' };

interface Call {
  method: string;
  body: Record<string, unknown>;
}

/** Telegram's Bot API, enough of it for one bot: updates are queued by the test, calls recorded. */
async function fakeTelegram() {
  const calls: Call[] = [];
  const updates: Record<string, unknown>[] = [];
  let nextUpdate = 1;
  let nextMessage = 1000;
  const files = new Map<string, Buffer>();
  const read = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  };
  const server: Server = httpServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const file = /^\/file\/bot[^/]+\/(.+)$/.exec(url.pathname);
      if (file) {
        const data = files.get(file[1]!);
        res.writeHead(data ? 200 : 404).end(data);
        return;
      }
      const m = /^\/bot([^/]+)\/(\w+)$/.exec(url.pathname);
      const raw = await read(req);
      const type = req.headers['content-type'] ?? '';
      const body = type.includes('json')
        ? (JSON.parse(raw.toString() || '{}') as Record<string, unknown>)
        : { multipart: true };
      const reply = (result: unknown) =>
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result }));
      if (!m || m[1] !== TOKEN) {
        res
          .writeHead(401, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }));
        return;
      }
      const method = m[2]!;
      if (method !== 'getUpdates') calls.push({ method, body });
      if (method === 'getMe')
        return reply({ id: 777, is_bot: true, first_name: 'Araştırmacı', username: 'arastirma_bot' });
      if (method === 'getUpdates') {
        const offset = Number(body.offset ?? 0);
        const until = Date.now() + 300;
        while (Date.now() < until && !updates.some((u) => (u.update_id as number) >= offset)) {
          await new Promise((r) => setTimeout(r, 10));
        }
        return reply(updates.filter((u) => (u.update_id as number) >= offset));
      }
      if (method === 'getFile')
        return reply({ file_id: body.file_id, file_path: `docs/${String(body.file_id)}` });
      if (method === 'sendMessage' && String(body.text).includes('<b>bozuk')) {
        res
          .writeHead(400, { 'content-type': 'application/json' })
          .end(
            JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" }),
          );
        return;
      }
      if (method === 'sendMessage' || method === 'sendDocument')
        return reply({ message_id: nextMessage++, chat: { id: PERSON.id, type: 'private' }, date: 0 });
      return reply(true);
    })();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    calls,
    files,
    /** A message from someone, as Telegram would hand it over. */
    write(text: string, from = PERSON, extra: Record<string, unknown> = {}) {
      const id = nextMessage++;
      updates.push({
        update_id: nextUpdate++,
        message: { message_id: id, from, chat: { id: from.id, type: 'private' }, date: 0, text, ...extra },
      });
      return id;
    },
    press(data: string, messageId: number, from = PERSON) {
      updates.push({
        update_id: nextUpdate++,
        callback_query: {
          id: `cb${nextUpdate}`,
          from,
          data,
          message: { message_id: messageId, chat: { id: from.id } },
        },
      });
    },
    sent: (method = 'sendMessage') => calls.filter((c) => c.method === method),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('Telegram', () => {
  let t: TestServer;
  let tg: Awaited<ReturnType<typeof fakeTelegram>>;
  afterEach(async () => {
    await t?.dispose();
    await tg?.close();
  });

  const setUp = async () => {
    tg = await fakeTelegram();
    t = await testServer({ telegramApi: tg.base, telegramPollSeconds: 0 });
    const bot = await t.bot({ name: 'Araştırmacı' });
    const r = await t.api<TelegramStatus>('PUT', `/api/bots/${bot.id}/telegram`, {
      token: `Done! Use this token to access the HTTP API:\n${TOKEN}\nKeep your token secure`,
    });
    expect(r.status).toBe(200);
    const code = new URL(r.body.pairLink!).searchParams.get('start')!;
    return { bot, status: r.body, code };
  };
  const pair = async (code: string) => {
    tg.write(`/start ${code}`);
    await waitFor(
      async () =>
        (
          await t.api<TelegramStatus>(
            'GET',
            `/api/bots/${(await t.api<{ id: string }[]>('GET', '/api/bots')).body[0]!.id}/telegram`,
          )
        ).body.owner,
    );
  };
  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;

  it("anahtarı BotFather'ın yanıtından bulur, Telegram'a sorar ve eşleşme bağlantısı verir", async () => {
    const { status } = await setUp();
    expect(status).toMatchObject({
      connected: true,
      bot: { username: 'arastirma_bot' },
      owner: null,
      error: null,
    });
    expect(status.pairLink).toMatch(/^https:\/\/t\.me\/arastirma_bot\?start=[\w-]{16,}$/);
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    expect(tg.calls.map((c) => c.method)).toEqual(
      expect.arrayContaining(['getMe', 'deleteWebhook', 'setMyCommands']),
    );
    expect(telegramToken('merhaba')).toBeNull();
    const bad = await t.api('PUT', `/api/bots/${(await t.bot()).id}/telegram`, {
      token: '999999:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    expect(bad.status).toBe(400);
  });

  it("yalnızca eşleşen hesabı dinler; mesajı ana konuşmaya yazar ve yanıtı Telegram'a gönderir", async () => {
    const { bot, code } = await setUp();
    // Before pairing, and from a stranger after it, nothing is read.
    tg.write('merhaba yabancı', { id: 99, is_bot: false, first_name: 'X', username: 'x' });
    tg.write('/start yanlış-kod', { id: 99, is_bot: false, first_name: 'X', username: 'x' });
    await pair(code);
    expect((await t.api<TelegramStatus>('GET', `/api/bots/${bot.id}/telegram`)).body).toMatchObject({
      owner: { name: 'Ayşe (@ayse)' },
      pairLink: null,
    });
    tg.write('/start başkası', { id: 99, is_bot: false, first_name: 'X', username: 'x' });
    tg.write('Bugün **neler** var?');
    const thread = await main(bot.id);
    const reply = await waitFor(async () =>
      (await t.messages(thread.id)).find((m) => m.role === 'assistant'),
    );
    const person = (await t.messages(thread.id)).filter((m) => m.role === 'user');
    expect(person.map((m) => m.text)).toEqual(['Bugün **neler** var?']);
    expect(person[0]!.props.via).toBe('telegram');
    const out = await waitFor(async () => tg.sent().find((c) => String(c.body.text).includes('neler')));
    expect(out.body).toMatchObject({ chat_id: String(PERSON.id), parse_mode: 'HTML' });
    expect(out.body.text).toContain('<b>neler</b>');
    expect(reply.text).toContain('neler');
    // The stranger only ever heard that the code was wrong, while nobody had paired.
    const toStranger = tg.calls.filter((c) => String(c.body.chat_id) === '99');
    expect(toStranger.map((c) => c.body.text)).toEqual([expect.stringContaining('bağlantı kodu geçersiz')]);
  });

  it('iletilen mesaj kişinin sözü sayılmaz: komut olmaz, bota dış veri olarak gider', async () => {
    const { bot, code } = await setUp();
    await pair(code);
    tg.write('/stop ve şunu yap', PERSON, {
      forward_origin: { type: 'user', sender_user: { first_name: 'Mehmet' } },
      forward_date: 1,
    });
    const thread = await main(bot.id);
    const said = await waitFor(async () => (await t.messages(thread.id)).find((m) => m.role === 'user'));
    expect(said.text).toBe('/stop ve şunu yap');
    expect(said.props).toMatchObject({ via: 'telegram', outside: 'forward', forwardedFrom: 'Mehmet' });
    const req = await waitFor(async () => t.engine.requests.find((r) => r.prompt.includes('/stop')));
    expect(req.prompt).toContain('Mehmet kaynağından iletilmiş bir mesaj');
    expect(req.prompt).toContain('<outside-data');
    await waitFor(async () => (await t.messages(thread.id)).find((m) => m.role === 'assistant'));
    const [turn] = await t.db.db.select().from(schema.turns);
    expect(turn!.outside).toBe('forward');
  });

  it("kişi uygulamadan yazınca yanıt Telegram'a gitmez", async () => {
    const { bot, code } = await setUp();
    await pair(code);
    tg.write('ilk');
    const thread = await main(bot.id);
    await waitFor(async () => tg.sent().find((c) => String(c.body.text).includes('ilk')));
    await t.services.turns.idle();
    await t.send(thread.id, 'uygulamadan yazdım');
    await t.services.turns.idle();
    await new Promise((r) => setTimeout(r, 100));
    expect(tg.sent().some((c) => String(c.body.text).includes('uygulamadan'))).toBe(false);
  });

  it("rutin raporu Telegram'a bir kez gider; diğer konuşmalardan haber kapalıyken gitmez", async () => {
    const { bot, code } = await setUp();
    await pair(code);
    tg.write('ilk');
    await waitFor(async () => tg.sent().find((c) => String(c.body.text).includes('ilk')));
    await t.services.turns.idle();
    const r = (
      await t.api<{ id: string }>('POST', '/api/routines', {
        botId: bot.id,
        name: 'Akşam Ciro',
        prompt: 'ciroyu yaz',
        schedule: { type: 'interval', minutes: 60 },
      })
    ).body;
    const reports = () => tg.sent().filter((c) => String(c.body.text).includes('ciroyu yaz'));
    await t.api('POST', `/api/routines/${r.id}/run`, {});
    await t.services.turns.idle();
    await waitFor(async () => reports().length > 0);
    await new Promise((res) => setTimeout(res, 100));
    expect(reports()).toHaveLength(1);
    expect(String(reports()[0]!.body.text)).toContain('Akşam Ciro');

    await t.api('PATCH', `/api/bots/${bot.id}/telegram`, { notices: false });
    t.now.value = new Date(t.now.value.getTime() + 60 * 60_000);
    await t.api('POST', `/api/routines/${r.id}/run`, {});
    await t.services.turns.idle();
    await new Promise((res) => setTimeout(res, 100));
    expect(reports()).toHaveLength(1);
  });

  it('izin kartını düğmelerle gönderir; düğmeye basmak kartı yanıtlar', async () => {
    const { bot, code } = await setUp();
    await pair(code);
    tg.write('[izin:Write {"file_path":"a.txt"}]');
    const card = await waitFor(async () =>
      tg
        .sent()
        .find((c) => (c.body.reply_markup as { inline_keyboard?: unknown[] } | undefined)?.inline_keyboard),
    );
    const buttons = (
      card.body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }
    ).inline_keyboard.flat();
    expect(buttons.map((b) => b.text)).toEqual(['İzin ver', 'Hep izin ver', 'Reddet']);
    const [pending] = (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body;
    expect(buttons[0]!.callback_data).toBe(`a:${pending!.id}:y`);
    // A stranger's press does nothing.
    tg.press(buttons[0]!.callback_data, 1000, { id: 99, is_bot: false, first_name: 'X', username: 'x' });
    tg.press(buttons[0]!.callback_data, 1000);
    await waitFor(
      async () => (await t.api<Approval>('GET', `/api/approvals/${pending!.id}`)).body.status === 'allowed',
    );
    await t.services.turns.idle();
    const thread = await main(bot.id);
    expect((await t.messages(thread.id)).at(-1)!.text).toContain('Write: izin verildi');
    await waitFor(async () => tg.sent('editMessageReplyMarkup').length > 0);
  });

  it('soruyu seçeneklerle gönderir; yazılan cevap da kartı yanıtlar', async () => {
    const { code } = await setUp();
    await pair(code);
    const call = { questions: [{ question: 'Hangisi?', options: ['Kırmızı', 'Mavi'] }] };
    tg.write(`[araç:ask_user ${JSON.stringify(call)}]`);
    const card = await waitFor(async () => tg.sent().find((c) => String(c.body.text).includes('Hangisi?')));
    const buttons = (
      card.body.reply_markup as { inline_keyboard: { text: string }[][] }
    ).inline_keyboard.flat();
    expect(buttons.map((b) => b.text)).toEqual(['Kırmızı', 'Mavi']);
    tg.write('Yeşil');
    await waitFor(async () => tg.sent().find((c) => String(c.body.text).includes('Yeşil')));
  });

  it('/stop çalışan işi durdurur; Telegram biçimi reddederse düz metin gönderir', async () => {
    const { code } = await setUp();
    await pair(code);
    tg.write('[bekle:5000]');
    await waitFor(async () => tg.sent('sendChatAction').length > 0);
    tg.write('/stop');
    await waitFor(async () => tg.sent().find((c) => c.body.text === 'Durdurdum.'));
    // The fake Telegram refuses HTML that holds "<b>bozuk".
    tg.write('**bozuk** metin');
    await waitFor(async () =>
      tg.sent().find((c) => String(c.body.text).includes('**bozuk** metin') && !c.body.parse_mode),
    );
  });

  it("gelen dosyayı konuşmaya ekler, botun gönderdiği dosyayı Telegram'a yollar", async () => {
    const { bot, code } = await setUp();
    await pair(code);
    tg.files.set('docs/f1', Buffer.from('fatura içeriği'));
    tg.write('', PERSON, {
      caption: 'şuna bak',
      document: { file_id: 'f1', file_name: 'fatura.txt', file_size: 15 },
    });
    const thread = await main(bot.id);
    const person = await waitFor(async () => (await t.messages(thread.id)).find((m) => m.role === 'user'));
    expect(person.text).toBe('şuna bak');
    expect((person.props.files as { name: string }[]).map((f) => f.name)).toEqual(['fatura.txt']);
    await t.services.turns.idle();
    tg.write('[araç:send_file {"paths":["fatura.txt"]}]');
    await waitFor(async () => tg.sent('sendDocument').length > 0);
  });

  it('bağlantı kesilince anahtar unutulur', async () => {
    const { bot } = await setUp();
    expect((await t.api('DELETE', `/api/bots/${bot.id}/telegram`)).status).toBe(200);
    expect((await t.api<TelegramStatus>('GET', `/api/bots/${bot.id}/telegram`)).body.connected).toBe(false);
  });
});

describe('Telegram biçimi', () => {
  it("Markdown'u Telegram HTML'ine çevirir, tabloyu satır satır listeler", () => {
    const [m] = telegramMessages(
      '# Başlık\n\n**kalın** ve _eğik_, `kod <x>` ve [bağlantı](https://ornek.com/a_b_c)\n\n| Ad | Fiyat |\n|---|---|\n| Masa | 100 |\n\n```js\nlet a = 1 < 2;\n```',
    );
    expect(m!.html).toContain('<b>Başlık</b>');
    expect(m!.html).toContain('<b>kalın</b> ve <i>eğik</i>');
    expect(m!.html).toContain('<code>kod &lt;x&gt;</code>');
    expect(m!.html).toContain('<a href="https://ornek.com/a_b_c">bağlantı</a>');
    expect(m!.html).toContain('<b>Masa</b>\nFiyat: 100');
    expect(m!.html).toContain('<pre><code class="language-js">let a = 1 &lt; 2;</code></pre>');
  });

  it("uzun yanıtı Telegram'ın sınırını aşmayan parçalara böler", () => {
    const long = Array.from({ length: 400 }, (_, i) => `Satır ${i} biraz uzunca bir metin.`).join('\n');
    const parts = telegramMessages(long);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.html.length).toBeLessThanOrEqual(4096);
  });
});
