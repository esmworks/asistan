import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { Approval, Thread, WhatsAppStatus } from '@yumakbot/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WhatsAppChannel,
  type WaConnectOptions,
  type WaLibrary,
  type WaMessage,
  type WaSocket,
} from '../src/channels/whatsapp';
import { schema } from '../src/db';
import { whatsappMessages } from '../src/channels/format';
import { testServer, waitFor, type TestServer } from './helpers';

const PERSON = '905321234567';
const BOT_NUMBER = '905559876543';

/** A stand-in for Baileys: a socket the test drives, and every message it is asked to send. */
function fakeLibrary() {
  const sent: { jid: string; content: Record<string, unknown>; id: string }[] = [];
  const presence: string[] = [];
  let socket: (WaSocket & { emit(e: string, v: unknown): void }) | null = null;
  let n = 0;
  let connects = 0;
  let options: WaConnectOptions | null = null;
  const flags = { failDownload: false, dropOnSend: false };
  /** Every send tried, with the id it carried, including those the connection dropped under. */
  const tried: { content: Record<string, unknown>; id?: string }[] = [];
  const lib: WaLibrary = {
    connect: (_auth, o) => {
      connects++;
      options = o;
      const ev = new EventEmitter();
      socket = {
        ev: ev as unknown as WaSocket['ev'],
        user: null,
        emit: (e, v) => ev.emit(e, v),
        sendMessage: async (jid, content, o) => {
          tried.push({ content, id: o?.messageId });
          if (flags.dropOnSend) {
            // The message may have reached WhatsApp, but the answer is lost with the connection.
            flags.dropOnSend = false;
            ev.emit('connection.update', {
              connection: 'close',
              lastDisconnect: { error: { output: { statusCode: 428 } } },
            });
            throw new Error('Connection Closed');
          }
          const id = o?.messageId ?? `sent-${++n}`;
          sent.push({ jid, content, id });
          return { key: { id }, message: content };
        },
        sendPresenceUpdate: async (type) => {
          presence.push(type);
        },
        logout: async () => {},
        end: () => {},
      };
      return socket;
    },
    initAuthCreds: () => ({ registered: false }),
    replacer: (_k, v) => v,
    reviver: (_k, v) => v,
    appStateKey: (v) => v,
    download: async () => {
      if (flags.failDownload) throw new Error('indirilemedi');
      return Readable.from([Buffer.from('ses kaydı')]);
    },
    codes: { forbidden: 403, connectionReplaced: 440, multideviceMismatch: 411, restartRequired: 515 },
    loggedOut: 401,
  };
  return {
    lib,
    sent,
    tried,
    presence,
    flags,
    connects: () => connects,
    options: () => options!,
    socket: () => socket!,
    /** WhatsApp drops the connection with `code`. */
    drop(code: number) {
      socket!.emit('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: code } } },
      });
    },
    /** WhatsApp accepts the scan and the device is online as `number`. */
    linked(number: string) {
      socket!.user = { id: `${number}:3@s.whatsapp.net`, lid: '1234@lid' };
      socket!.emit('connection.update', { connection: 'open' });
    },
    message(from: string, message: Record<string, unknown>, key: Partial<WaMessage['key']> = {}) {
      socket!.emit('messages.upsert', {
        type: 'notify',
        messages: [
          { key: { remoteJid: `${from}@s.whatsapp.net`, fromMe: false, id: `in-${++n}`, ...key }, message },
        ],
      });
    },
    texts: () => sent.map((s) => s.content.text).filter((x): x is string => typeof x === 'string'),
  };
}

describe('WhatsApp', () => {
  let t: TestServer;
  afterEach(() => t?.dispose());

  const setUp = async (mode: 'own' | 'separate' = 'separate') => {
    t = await testServer();
    const wa = fakeLibrary();
    t.services.whatsapp.library = async () => wa.lib;
    t.services.whatsapp.paceMs = 0;
    const asistan = await t.bot({ name: 'Asistan' });
    const yazar = await t.bot({ name: 'Yazar' });
    const set = await t.api<WhatsAppStatus>('PUT', '/api/whatsapp', {
      mode,
      phone: '+90 532 123 45 67',
      botId: asistan.id,
    });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ mode, phone: PERSON, botId: asistan.id, state: 'off' });
    const linking = await t.api<WhatsAppStatus>('POST', '/api/whatsapp/link');
    expect(linking.body.state).toBe('linking');
    wa.socket().emit('connection.update', { qr: '2@abc,def' });
    const withQr = await waitFor(async () => (await t.api<WhatsAppStatus>('GET', '/api/whatsapp')).body.qr);
    expect(withQr).toMatch(/^data:image\/png;base64,/);
    wa.linked(mode === 'own' ? PERSON : BOT_NUMBER);
    await waitFor(
      async () => (await t.api<WhatsAppStatus>('GET', '/api/whatsapp')).body.state === 'connected',
    );
    return { wa, asistan, yazar };
  };
  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;

  it('ayrı numarada yalnızca kişinin numarasını okur ve yanıtı ona gönderir', async () => {
    const { wa, asistan } = await setUp();
    expect((await t.api<WhatsAppStatus>('GET', '/api/whatsapp')).body.linked).toBe(BOT_NUMBER);
    wa.message('905000000000', { conversation: 'yabancıyım' });
    wa.message(PERSON, { conversation: 'kendi mesajım' }, { fromMe: true });
    wa.message(PERSON, { conversation: 'Merhaba *asistan*' });
    const thread = await main(asistan.id);
    await waitFor(async () => (await t.messages(thread.id)).find((m) => m.role === 'assistant'));
    const person = (await t.messages(thread.id)).filter((m) => m.role === 'user');
    expect(person.map((m) => m.text)).toEqual(['Merhaba *asistan*']);
    expect(person[0]!.props.via).toBe('whatsapp');
    const reply = await waitFor(async () => wa.sent.find((s) => String(s.content.text).includes('Merhaba')));
    expect(reply.jid).toBe(`${PERSON}@s.whatsapp.net`);
    expect(wa.sent.every((s) => s.jid === `${PERSON}@s.whatsapp.net`)).toBe(true);
  });

  it('kendi numarasında yalnızca "kendine mesaj"daki kendi yazdığını okur', async () => {
    const { wa, asistan } = await setUp('own');
    // Someone else writing to the person is never read.
    wa.message('905000000000', { conversation: 'arkadaşın' });
    wa.message(PERSON, { conversation: 'kendime not' }, { fromMe: true });
    const thread = await main(asistan.id);
    await waitFor(async () => wa.sent.find((s) => String(s.content.text).includes('kendime not')));
    // The bot's own reply, handed back by WhatsApp as sent from this number, is not read again.
    const echoed = wa.sent.find((s) => String(s.content.text).includes('kendime not'))!;
    wa.message(PERSON, { conversation: String(echoed.content.text) }, { fromMe: true, id: echoed.id });
    await t.services.turns.idle();
    await new Promise((r) => setTimeout(r, 100));
    const person = (await t.messages(thread.id)).filter((m) => m.role === 'user');
    expect(person.map((m) => m.text)).toEqual(['kendime not']);
  });

  it('/bot ile başka bota geçer; komutlar bota gitmez', async () => {
    const { wa, asistan, yazar } = await setUp();
    wa.message(PERSON, { conversation: '/bot' });
    await waitFor(async () => wa.texts().find((x) => x.includes('*Asistan*') && x.includes('Yazar')));
    wa.message(PERSON, { conversation: '/bot olmayan' });
    await waitFor(async () => wa.texts().find((x) => x.includes('"olmayan"')));
    wa.message(PERSON, { conversation: '/bot yaz' });
    await waitFor(async () => wa.texts().find((x) => x.includes('Artık *Yazar*')));
    expect((await t.api<WhatsAppStatus>('GET', '/api/whatsapp')).body.botId).toBe(yazar.id);
    wa.message(PERSON, { extendedTextMessage: { text: 'yazara selam' } });
    const thread = await main(yazar.id);
    await waitFor(async () => (await t.messages(thread.id)).find((m) => m.text === 'yazara selam'));
    expect((await t.messages((await main(asistan.id)).id)).filter((m) => m.role === 'user')).toHaveLength(0);
  });

  it('izin kartını numaralı seçeneklerle gönderir; numara yazmak kartı yanıtlar', async () => {
    const { wa } = await setUp();
    wa.message(PERSON, { conversation: '[izin:Write {"file_path":"a.txt"}]' });
    const card = await waitFor(async () => wa.texts().find((x) => x.includes('1. İzin ver')));
    expect(card).toContain('2. Hep izin ver');
    expect(card).toContain('3. Reddet');
    const [pending] = (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body;
    wa.message(PERSON, { conversation: '3' });
    await waitFor(
      async () => (await t.api<Approval>('GET', `/api/approvals/${pending!.id}`)).body.status === 'denied',
    );
  });

  it('yalnız bir sayı "hep izin ver"i seçmez; sayı ve sözcük seçer', async () => {
    const { wa } = await setUp();
    wa.message(PERSON, { conversation: '[izin:Write {"file_path":"a.txt"}]' });
    const card = await waitFor(async () => wa.texts().find((x) => x.includes('1. İzin ver')));
    expect(card).toContain('2. Hep izin ver (hep izin vermek için “2 hep” yaz)');
    const [pending] = (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body;
    wa.message(PERSON, { conversation: '2' });
    await waitFor(async () => wa.texts().find((x) => x.includes('Yalnız bir sayı')));
    expect((await t.api<Approval>('GET', `/api/approvals/${pending!.id}`)).body.status).toBe('pending');
    wa.message(PERSON, { conversation: '2 hep' });
    await waitFor(
      async () => (await t.api<Approval>('GET', `/api/approvals/${pending!.id}`)).body.remembered === true,
    );
  });

  it('iletilen mesaj kişinin sözü sayılmaz; bota dış veri olarak gider', async () => {
    const { wa, asistan } = await setUp();
    wa.message(PERSON, {
      extendedTextMessage: { text: '/bot Yazar', contextInfo: { isForwarded: true, forwardingScore: 1 } },
    });
    const thread = await main(asistan.id);
    const said = await waitFor(async () => (await t.messages(thread.id)).find((m) => m.role === 'user'));
    expect(said.props).toMatchObject({ via: 'whatsapp', outside: 'forward' });
    const req = await waitFor(async () => t.engine.requests.find((r) => r.prompt.includes('/bot Yazar')));
    expect(req.prompt).toContain('iletilmiş bir mesaj');
  });

  it('gelen sesli mesajı dosya olarak ekler', async () => {
    const { wa, asistan } = await setUp();
    wa.message(PERSON, { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true, fileLength: 9 } });
    const thread = await main(asistan.id);
    const person = await waitFor(async () => (await t.messages(thread.id)).find((m) => m.role === 'user'));
    expect((person.props.files as { name: string }[])[0]!.name).toMatch(/^voice-.+\.ogg$/);
  });

  it('ayrı numara seçiliyken kişinin kendi numarası bağlanırsa reddeder', async () => {
    t = await testServer();
    const wa = fakeLibrary();
    t.services.whatsapp.library = async () => wa.lib;
    const bot = await t.bot();
    await t.api('PUT', '/api/whatsapp', { mode: 'separate', phone: PERSON, botId: bot.id });
    await t.api('POST', '/api/whatsapp/link');
    wa.linked(PERSON);
    const s = await waitFor(async () => {
      const st = (await t.api<WhatsAppStatus>('GET', '/api/whatsapp')).body;
      return st.state === 'error' ? st : null;
    });
    expect(s.error).toBe('ownNumber');
  });

  it('botun yanıtına verilen yanıt o mesaja bağlanır; bilinmeyen mesajın metni ve dosyası gelir', async () => {
    const { wa, asistan } = await setUp();
    const thread = await main(asistan.id);
    wa.message(PERSON, { conversation: 'ilk soru' });
    const reply = await waitFor(async () => wa.sent.find((s) => String(s.content.text).includes('ilk soru')));
    wa.message(PERSON, {
      extendedTextMessage: {
        text: 'bunu açar mısın',
        contextInfo: { stanzaId: reply.id, quotedMessage: { conversation: 'yanıt' } },
      },
    });
    const answer = await waitFor(async () =>
      (await t.messages(thread.id)).find((m) => m.role === 'user' && m.text === 'bunu açar mısın'),
    );
    expect(answer.props.replyTo).toBeTruthy();
    expect(answer.props.outside).toBeUndefined();

    wa.message(PERSON, {
      extendedTextMessage: {
        text: 'buna bak',
        contextInfo: {
          stanzaId: 'eski-mesaj',
          quotedMessage: { imageMessage: { caption: 'fatura', mimetype: 'image/jpeg', fileLength: 9 } },
        },
      },
    });
    const withQuote = await waitFor(async () =>
      (await t.messages(thread.id)).find((m) => m.role === 'user' && m.text.endsWith('buna bak')),
    );
    expect(withQuote.text).toBe('> fatura\n\nbuna bak');
    expect(withQuote.props.replyTo).toBeUndefined();
    expect((withQuote.props.files as { name: string }[])[0]!.name).toMatch(/^photo-.+\.jpg$/);
    // Whose words the quote holds is not known here: never the person's request.
    expect(withQuote.props.outside).toBe('stored');

    wa.message(PERSON, {
      extendedTextMessage: {
        text: 'tamam',
        contextInfo: {
          stanzaId: 'iletilen',
          quotedMessage: {
            extendedTextMessage: { text: 'parayı gönder', contextInfo: { isForwarded: true } },
          },
        },
      },
    });
    const forward = await waitFor(async () =>
      (await t.messages(thread.id)).find((m) => m.role === 'user' && m.text.endsWith('tamam')),
    );
    expect(forward.props.outside).toBe('forward');
  });

  it('cihaz yokken bekletilen mesajları okur, eski geçmişi okumaz', async () => {
    const { wa, asistan } = await setUp();
    const thread = await main(asistan.id);
    const now = Math.floor(Date.now() / 1000);
    const append = (id: string, text: string, at: number) =>
      wa.socket().emit('messages.upsert', {
        type: 'append',
        messages: [
          {
            key: { remoteJid: `${PERSON}@s.whatsapp.net`, fromMe: false, id },
            message: { conversation: text },
            messageTimestamp: at,
          },
        ],
      });
    // Nothing read yet: an appended message is history, not new.
    append('gecmis-1', 'eski geçmiş', now - 60);
    wa.socket().emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: `${PERSON}@s.whatsapp.net`, fromMe: false, id: 'yeni-1' },
          message: { conversation: 'şimdi' },
          messageTimestamp: now - 30,
        },
      ],
    });
    await waitFor(async () => (await t.messages(thread.id)).find((m) => m.text === 'şimdi'));
    append('gecmis-2', 'daha eski', now - 45);
    append('bekleyen-1', 'yokken yazdım', now - 10);
    await waitFor(async () => (await t.messages(thread.id)).find((m) => m.text === 'yokken yazdım'));
    await t.services.turns.idle();
    const texts = (await t.messages(thread.id)).filter((m) => m.role === 'user').map((m) => m.text);
    expect(texts).toEqual(['şimdi', 'yokken yazdım']);
  });

  const status = async () => (await t.api<WhatsAppStatus>('GET', '/api/whatsapp')).body;
  /** The server starts again with the device that was linked: a second channel on the same records. */
  const restart = async (wa: ReturnType<typeof fakeLibrary>, number: string) => {
    wa.socket().emit('creds.update', { me: { id: `${number}:3@s.whatsapp.net` } });
    await t.services.whatsapp.stop();
    const again = new WhatsAppChannel(t.services.ctx, t.services, t.services.vault);
    again.library = async () => wa.lib;
    again.paceMs = 0;
    await again.start();
    return again;
  };

  it('bağlantı kopukken yazılan yanıt düşmez; bağlantı gelince gider', async () => {
    const { wa } = await setUp();
    wa.message(PERSON, { conversation: '[bekle:300] merhaba' });
    wa.drop(428);
    await waitFor(async () => (await status()).state === 'connecting');
    await new Promise((r) => setTimeout(r, 500));
    expect(wa.texts().some((x) => x.includes('merhaba'))).toBe(false);
    await waitFor(async () => wa.connects() === 2);
    wa.linked(BOT_NUMBER);
    const reply = await waitFor(async () => wa.sent.find((s) => String(s.content.text).includes('merhaba')));
    expect(reply.jid).toBe(`${PERSON}@s.whatsapp.net`);
  });

  it('gönderim sırasında kopan bağlantıdan sonra yanıt aynı kimlikle bir kez daha gider', async () => {
    const { wa } = await setUp();
    wa.flags.dropOnSend = true;
    wa.message(PERSON, { conversation: '[bekle:100] merhaba' });
    await waitFor(async () => wa.connects() === 2);
    wa.linked(BOT_NUMBER);
    await waitFor(async () => wa.sent.find((s) => String(s.content.text).includes('merhaba')));
    const tries = wa.tried.filter((x) => String(x.content.text).includes('merhaba'));
    expect(tries).toHaveLength(2);
    expect(tries[0]!.id).toBeTruthy();
    expect(tries[1]!.id).toBe(tries[0]!.id);
  });

  it('başka yerde açılan numara (440) döngüye girmeden durur ve nedenini söyler', async () => {
    const { wa } = await setUp();
    wa.drop(440);
    const s = await waitFor(async () => {
      const st = await status();
      return st.state === 'error' ? st : null;
    });
    expect(s.error).toBe('replaced');
    await new Promise((r) => setTimeout(r, 1300));
    expect(wa.connects()).toBe(1);
  });

  it('süresi dolan yeni bağlantı eski cihazın anahtarlarını silmez; taranan yenisi onun yerine geçer', async () => {
    const { wa } = await setUp();
    // The device that works now has been saved with its account.
    wa.socket().emit('creds.update', { me: { id: `${BOT_NUMBER}:3@s.whatsapp.net` } });
    t.services.whatsapp.linkMs = 50;
    await t.api('POST', '/api/whatsapp/link');
    expect(await t.services.whatsapp.keyCount('link/')).toBe(1);
    expect(await t.services.whatsapp.keyCount('creds')).toBe(1);
    wa.socket().emit('connection.update', { qr: '2@abc,def' });
    // Never scanned: the new keys go and the old device comes back.
    await waitFor(async () => wa.connects() === 3);
    expect(await t.services.whatsapp.keyCount('link/')).toBe(0);
    expect(await t.services.whatsapp.keyCount('creds')).toBe(1);
    wa.linked(BOT_NUMBER);
    await waitFor(async () => (await status()).state === 'connected');
    expect((await status()).linked).toBe(BOT_NUMBER);

    t.services.whatsapp.linkMs = 60_000;
    await t.api('POST', '/api/whatsapp/link');
    wa.socket().emit('connection.update', { qr: '2@abc,def' });
    wa.linked(BOT_NUMBER);
    await waitFor(async () => (await status()).state === 'connected');
    expect(await t.services.whatsapp.keyCount('link/')).toBe(0);
    expect(await t.services.whatsapp.keyCount('creds')).toBe(1);

    // What the new device writes after taking over stays its own across a restart.
    const before = wa.connects();
    const again = await restart(wa, BOT_NUMBER);
    expect(await again.keyCount('link/')).toBe(0);
    expect(await again.keyCount('creds')).toBe(1);
    await waitFor(async () => wa.connects() === before + 1);
    await again.stop();
  });

  it('gönderilen mesaj, telefonun yeniden gönderme isteği için geri verilir', async () => {
    const { wa } = await setUp();
    wa.message(PERSON, { conversation: 'selam' });
    const reply = await waitFor(async () => wa.sent.find((s) => String(s.content.text).includes('selam')));
    expect(await wa.options().getMessage({ id: reply.id })).toEqual(reply.content);
    expect(await wa.options().getMessage({ id: 'hiç-gönderilmedi' })).toBeUndefined();
  });

  it('aynı mesaj numarası iki kez gelirse kart ikinci kez yanıtlanmaz, bota da gitmez', async () => {
    const { wa, asistan } = await setUp();
    wa.message(PERSON, { conversation: '[izin:Write {"file_path":"a.txt"}]' });
    await waitFor(async () => wa.texts().find((x) => x.includes('1. İzin ver')));
    const [pending] = (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body;
    wa.message(PERSON, { conversation: '1' }, { id: 'tekrar-1' });
    wa.message(PERSON, { conversation: '1' }, { id: 'tekrar-1' });
    await waitFor(
      async () => (await t.api<Approval>('GET', `/api/approvals/${pending!.id}`)).body.status !== 'pending',
    );
    await t.services.turns.idle();
    await new Promise((r) => setTimeout(r, 150));
    const said = (await t.messages((await main(asistan.id)).id)).filter((m) => m.role === 'user');
    expect(said.filter((m) => m.text === '1')).toHaveLength(0);
  });

  it('yeniden başlatmadan sonra kendi gönderdiği mesajı kayıttan tanır', async () => {
    const { wa, asistan } = await setUp('own');
    wa.message(PERSON, { conversation: 'kendime not' }, { fromMe: true });
    const echoed = await waitFor(async () =>
      wa.sent.find((s) => String(s.content.text).includes('kendime not')),
    );
    await waitFor(async () => (await t.db.db.select().from(schema.channelMessages)).length >= 2);
    const again = await restart(wa, PERSON);
    wa.linked(PERSON);
    await waitFor(async () => (await status()).state === 'connected');
    wa.message(PERSON, { conversation: String(echoed.content.text) }, { fromMe: true, id: echoed.id });
    await new Promise((r) => setTimeout(r, 200));
    const person = (await t.messages((await main(asistan.id)).id)).filter((m) => m.role === 'user');
    expect(person.map((m) => m.text)).toEqual(['kendime not']);
    await again.stop();
  });

  it('yarıda kalan istek, bağlantı açılınca kişiye haber verilip kayıttan silinir', async () => {
    const { wa, asistan } = await setUp();
    const thread = await main(asistan.id);
    const [row] = await t.db.db.select().from(schema.channels);
    await t.db.db
      .insert(schema.channelRequests)
      .values({ channelId: row!.id, threadId: thread.id, place: { jid: `${PERSON}@s.whatsapp.net` } });
    const again = await restart(wa, BOT_NUMBER);
    // Not before the connection is open: there is no one to tell yet.
    await new Promise((r) => setTimeout(r, 100));
    expect(wa.texts()).toHaveLength(0);
    expect(await t.db.db.select().from(schema.channelRequests)).toHaveLength(1);
    wa.linked(BOT_NUMBER);
    await waitFor(async () => wa.texts().find((x) => x.includes('yarıda kaldı')));
    await waitFor(async () => (await t.db.db.select().from(schema.channelRequests)).length === 0);
    await again.stop();
  });

  it('ulaşmayan dosya bota da söylenir', async () => {
    const { wa, asistan } = await setUp();
    wa.flags.failDownload = true;
    wa.message(PERSON, { imageMessage: { caption: 'bak', mimetype: 'image/jpeg', fileLength: 9 } });
    const thread = await main(asistan.id);
    const said = await waitFor(async () => (await t.messages(thread.id)).find((m) => m.role === 'user'));
    expect(said.text).toMatch(/^bak\n\n\(Ulaşmayan dosyalar: photo-.+\.jpg\)$/);
    await waitFor(async () => wa.texts().find((x) => x.includes('alınamadı')));
  });

  it('bağlantı kesilince anahtarlar silinir', async () => {
    await setUp();
    expect(await t.services.whatsapp.keyCount('creds')).toBe(1);
    const off = await t.api<WhatsAppStatus>('DELETE', '/api/whatsapp');
    expect(off.body.state).toBe('off');
    expect(await t.services.whatsapp.keyCount()).toBe(0);
  });
});

describe('WhatsApp biçimi', () => {
  it('Markdown işaretlerini WhatsApp işaretlerine çevirir', () => {
    const [m] = whatsappMessages(
      '# Başlık\n\n**kalın**, _eğik_, ~~çizik~~ ve [site](https://ornek.com)\n\n- madde',
    );
    expect(m).toBe('*Başlık*\n\n*kalın*, _eğik_, ~çizik~ ve site (https://ornek.com)\n\n• madde');
  });
});
