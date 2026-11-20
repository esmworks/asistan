import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Approval, Routine, RoutineRun, Thread, WhatsAppStatus } from '@yumakbot/shared';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WhatsAppChannel,
  type WaConnectOptions,
  type WaLibrary,
  type WaMessage,
  type WaSocket,
} from '../src/channels/whatsapp';
import { schema } from '../src/db';
import { pickGroup } from '../src/tools/whatsapp';
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
  /** The groups the linked account is in. */
  const groups: Record<string, { id: string; subject: string }> = {};
  /** The numbers that are on WhatsApp. */
  const onWa = new Set<string>();
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
        groupFetchAllParticipating: async () => groups,
        onWhatsApp: async (...jids) =>
          jids.map((jid) => ({ jid, exists: onWa.has(jid.replace(/@.*$/, '')) })),
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
    groups,
    onWa,
    /** A message in any chat: someone else's, or a group's (`participant` says who wrote it). */
    chat(
      remoteJid: string,
      message: Record<string, unknown>,
      key: Partial<WaMessage['key']> = {},
      pushName?: string,
    ) {
      const id = `in-${++n}`;
      socket!.emit('messages.upsert', {
        type: 'notify',
        messages: [{ key: { remoteJid, fromMe: false, id, ...key }, message, pushName }],
      });
      return id;
    },
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
    expect(card).toContain('2. Hep izin ver (tam yetki)');
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
    expect(card).toContain('2. Hep izin ver (tam yetki) (hep izin vermek için “2 hep” yaz)');
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

describe('WhatsApp: rutinlerin okuduğu sohbetler', () => {
  let t: TestServer;
  afterEach(() => t?.dispose());
  const CUSTOMER = '905001112233';
  const GROUP = '120363000000000001@g.us';

  const setUp = async () => {
    t = await testServer();
    const wa = fakeLibrary();
    t.services.whatsapp.library = async () => wa.lib;
    t.services.whatsapp.paceMs = 0;
    t.services.whatsapp.chatQuietMs = 30;
    const asistan = await t.bot({ name: 'Asistan' });
    await t.api('PUT', '/api/whatsapp', { mode: 'own', phone: PERSON, botId: asistan.id });
    await t.api('POST', '/api/whatsapp/link');
    wa.socket().emit('connection.update', { qr: '2@abc,def' });
    await waitFor(async () => (await t.api<WhatsAppStatus>('GET', '/api/whatsapp')).body.qr);
    wa.linked(PERSON);
    await waitFor(
      async () => (await t.api<WhatsAppStatus>('GET', '/api/whatsapp')).body.state === 'connected',
    );
    return { wa, asistan };
  };
  const routine = async (botId: string, body: Record<string, unknown>) => {
    const r = await t.api<Routine>('POST', '/api/routines', {
      botId,
      name: 'Gelenler',
      prompt: 'Teklif isteği varsa hazırla.',
      schedule: { type: 'daily', time: '09:00' },
      ...body,
    });
    expect(r.status).toBe(200);
    return r.body;
  };
  const reads = () => t.services.whatsapp as unknown as { people: boolean; followed: Set<string> };
  const runs = (id: string) =>
    waitFor(async () => {
      const r = (await t.api<RoutineRun[]>('GET', `/api/routines/${id}/runs`)).body;
      return r.length ? r : undefined;
    });

  it('kişinin mesajı saklanır, sohbet sessizleşince kendi konuşmasında rutine gider; kodlar hiç saklanmaz', async () => {
    const { wa, asistan } = await setUp();
    const r = await routine(asistan.id, { whatsappPeople: true });
    await waitFor(async () => reads().people);
    wa.chat(
      `${CUSTOMER}@s.whatsapp.net`,
      { conversation: '2 adet soğuk oda için teklif istiyorum' },
      {},
      'Ahmet',
    );
    wa.chat('905009998877@s.whatsapp.net', {
      conversation: 'Doğrulama kodunuz: 482913. Kimseyle paylaşmayın.',
    });
    // The person's own chat with the bots is not a customer's.
    wa.chat(`${PERSON}@s.whatsapp.net`, { conversation: 'kendime not' }, { fromMe: true });
    const [run] = await runs(r.id);
    await t.services.turns.idle();
    expect(run!.occurrence).toMatch(/^wa:/);
    const [row] = await t.db.db.select({ trigger: schema.routineRuns.trigger }).from(schema.routineRuns);
    expect(row!.trigger).toBe('whatsapp');
    const prompt = t.engine.requests.at(-1)!.prompt;
    expect(prompt).toContain('teklif istiyorum');
    expect(prompt).toContain(`Ahmet (+${CUSTOMER})`);
    expect(prompt).toContain(`${CUSTOMER}@s.whatsapp.net`);
    expect(t.engine.requests.map((q) => q.prompt).join('\n')).not.toContain('482913');
    const chats = await t.db.db.select().from(schema.whatsappChats);
    expect(chats.map((c) => c.jid)).toEqual([`${CUSTOMER}@s.whatsapp.net`]);
    // A conversation of its own for this chat, not the bot's main one.
    const thread = (await t.api<Thread>('GET', `/api/threads/${run!.threadId}`)).body;
    expect(thread.title).toContain('Ahmet');
    expect(wa.sent.filter((x) => x.jid.startsWith(CUSTOMER))).toHaveLength(0);
  });

  it('yalnızca takip edilen grup okunur; dosyası botun klasörüne iner, gruba hiçbir şey yazılmaz', async () => {
    const { wa, asistan } = await setUp();
    wa.groups[GROUP] = { id: GROUP, subject: '3E Soğutma - Finans' };
    const list = await t.api<{ id: string; name: string }[]>('GET', '/api/whatsapp/groups');
    expect(list.body).toEqual([{ id: GROUP, name: '3E Soğutma - Finans' }]);
    const r = await routine(asistan.id, { whatsappGroup: GROUP });
    await waitFor(async () => reads().followed.has(GROUP));
    expect(wa.options().ignore(GROUP)).toBe(false);
    expect(wa.options().ignore('120363999999999999@g.us')).toBe(true);
    wa.chat(
      '120363999999999999@g.us',
      { conversation: 'başka grup' },
      { participant: `${CUSTOMER}@s.whatsapp.net` },
    );
    wa.chat(
      GROUP,
      { imageMessage: { caption: 'Ödeme yapıldı 15.000 TL', mimetype: 'image/jpeg' } },
      { participant: `${CUSTOMER}@s.whatsapp.net` },
      'Ayşe',
    );
    await runs(r.id);
    await t.services.turns.idle();
    const prompt = t.engine.requests.at(-1)!.prompt;
    expect(prompt).toContain('WhatsApp grubu: 3E Soğutma - Finans');
    expect(prompt).toContain('Ödeme yapıldı 15.000 TL');
    expect(prompt).not.toContain('başka grup');
    const path = /: (\S+\.jpg) \(/.exec(prompt)![1]!;
    expect(path.startsWith(join(t.dataDir, 'workspaces', 'bots', asistan.id, 'files', 'whatsapp'))).toBe(
      true,
    );
    expect(readFileSync(path, 'utf8')).toBe('ses kaydı');
    expect(wa.sent.filter((x) => x.jid.endsWith('@g.us'))).toHaveLength(0);
  });

  it('cevap taslağı kartla sunulur; "Gönderme" gitmez, "Gönder" müşteriye gider', async () => {
    const { wa, asistan } = await setUp();
    const send = (text: string) =>
      `[araç:whatsapp_send {"chat":"${CUSTOMER}@s.whatsapp.net","text":"${text}"}]`;
    const r = await routine(asistan.id, {
      whatsappPeople: true,
      prompt: `Cevap hazırla. ${send('Teklifimiz 120.000 TL')}`,
    });
    await waitFor(async () => reads().people);
    wa.chat(`${CUSTOMER}@s.whatsapp.net`, { conversation: 'Fiyat alabilir miyim?' }, {}, 'Ahmet');
    await runs(r.id);
    await t.services.turns.idle();
    const card = await waitFor(async () => {
      const list = (await t.api<Approval[]>('GET', '/api/approvals')).body;
      return list.find((a) => a.toolName === 'whatsapp_send');
    });
    expect(card.summary).toContain('Teklifimiz 120.000 TL');
    expect(wa.sent.filter((x) => x.jid.startsWith(CUSTOMER))).toHaveLength(0);
    // Cards from before a restart are let go, but a draft's card stays.
    await t.services.approvals.expireAllPending();
    expect((await t.services.approvals.get(card.id)).status).toBe('pending');
    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'allow', answer: 'Gönder' });
    await waitFor(async () => wa.sent.some((x) => x.jid === `${CUSTOMER}@s.whatsapp.net`));
    expect(wa.sent.find((x) => x.jid === `${CUSTOMER}@s.whatsapp.net`)!.content.text).toBe(
      'Teklifimiz 120.000 TL',
    );
    const [draft] = await t.db.db.select().from(schema.whatsappDrafts);
    expect(draft!.status).toBe('sent');

    // A second draft turned down goes nowhere.
    wa.chat(`${CUSTOMER}@s.whatsapp.net`, { conversation: 'Peki teslim ne zaman?' }, {}, 'Ahmet');
    const second = await waitFor(async () => {
      const list = (await t.api<Approval[]>('GET', '/api/approvals')).body;
      return list.find((a) => a.toolName === 'whatsapp_send' && a.id !== card.id && a.status === 'pending');
    });
    await t.api('POST', `/api/approvals/${second.id}`, { decision: 'allow', answer: 'Gönderme' });
    await waitFor(async () => {
      const rows = await t.db.db.select().from(schema.whatsappDrafts);
      return rows.some((d) => d.status === 'dropped');
    });
    expect(wa.sent.filter((x) => x.jid === `${CUSTOMER}@s.whatsapp.net`)).toHaveLength(1);
  });

  it('kod gibi görünen mesaj saklanmaz ama atlandığı söylenir; bilinmeyen numaradan gelen iz bırakmaz', async () => {
    const { wa, asistan } = await setUp();
    const r = await routine(asistan.id, { whatsappPeople: true });
    await waitFor(async () => reads().people);
    // A code from a number with no chat here: nothing at all.
    wa.chat('905007776655@s.whatsapp.net', { conversation: 'Giriş kodunuz 552211' });
    wa.chat(`${CUSTOMER}@s.whatsapp.net`, { conversation: 'Dekontu da gönderiyorum' }, {}, 'Ahmet');
    wa.chat(
      `${CUSTOMER}@s.whatsapp.net`,
      { conversation: 'Havale yapıldı, işlem onay kodu 845123' },
      {},
      'Ahmet',
    );
    await runs(r.id);
    await t.services.turns.idle();
    const prompt = t.engine.requests.at(-1)!.prompt;
    expect(prompt).toContain('Bir mesaj atlandı');
    expect(prompt).toContain('Dekontu da gönderiyorum');
    expect(prompt).not.toContain('845123');
    const chats = await t.db.db.select().from(schema.whatsappChats);
    expect(chats.map((c) => c.jid)).toEqual([`${CUSTOMER}@s.whatsapp.net`]);
  });

  it('kart WhatsApp’a numaralı gelir; "1" yazmak taslağı gönderir', async () => {
    const { wa, asistan } = await setUp();
    // The person talks to the bot from WhatsApp, so its cards come there.
    wa.message(PERSON, { conversation: 'merhaba' }, { fromMe: true });
    await waitFor(async () => wa.texts().length > 0);
    await t.services.turns.idle();
    const r = await routine(asistan.id, {
      whatsappPeople: true,
      prompt: `[araç:whatsapp_send {"chat":"${CUSTOMER}@s.whatsapp.net","text":"Teslim 2 hafta"}]`,
    });
    await waitFor(async () => reads().people);
    wa.chat(`${CUSTOMER}@s.whatsapp.net`, { conversation: 'Teslim süresi?' }, {}, 'Ahmet');
    await runs(r.id);
    await t.services.turns.idle();
    await waitFor(async () =>
      wa.texts().some((x) => x.includes('Teslim 2 hafta') && x.includes('1. Gönder')),
    );
    wa.message(PERSON, { conversation: '1' }, { fromMe: true });
    await waitFor(async () => wa.sent.some((x) => x.jid === `${CUSTOMER}@s.whatsapp.net`));
    expect(wa.sent.find((x) => x.jid === `${CUSTOMER}@s.whatsapp.net`)!.content.text).toBe('Teslim 2 hafta');
  });

  it('kartın ardından numaralı bir rapor gelince "1" kartı onaylamaz', async () => {
    const { wa, asistan } = await setUp();
    wa.message(PERSON, { conversation: 'merhaba' }, { fromMe: true });
    await waitFor(async () => wa.texts().length > 0);
    await t.services.turns.idle();
    const r = await routine(asistan.id, {
      whatsappPeople: true,
      prompt: `[araç:whatsapp_send {"chat":"${CUSTOMER}@s.whatsapp.net","text":"Teslim 2 hafta"}]`,
    });
    await waitFor(async () => reads().people);
    wa.chat(`${CUSTOMER}@s.whatsapp.net`, { conversation: 'Teslim süresi?' }, {}, 'Ahmet');
    await runs(r.id);
    await t.services.turns.idle();
    await waitFor(async () => wa.texts().some((x) => x.includes('1. Gönder')));
    const card = (await t.api<Approval[]>('GET', '/api/approvals')).body.find(
      (a) => a.toolName === 'whatsapp_send',
    )!;
    // A report whose own list a "1" may mean.
    await t.services.threads.addMessage({
      threadId: card.threadId,
      role: 'assistant',
      author: `bot:${asistan.id}`,
      text: '1. Fatura kaydedildi\n2. Ödeme bekleniyor',
      props: { routineReport: true, routineName: 'Finans' },
    });
    await waitFor(async () => wa.texts().some((x) => x.includes('Fatura kaydedildi')));
    const asked = t.engine.requests.length;
    wa.message(PERSON, { conversation: '1' }, { fromMe: true });
    // It goes to the bot as a message instead.
    await waitFor(async () => t.engine.requests.length > asked);
    await t.services.turns.idle();
    expect(wa.sent.filter((x) => x.jid === `${CUSTOMER}@s.whatsapp.net`)).toHaveLength(0);
    expect((await t.services.approvals.get(card.id)).status).toBe('pending');
  });

  it('meşgul bir rutin yüzünden yeniden sunulan parti, aynı adla ve eklenmeden gelir', async () => {
    const { wa, asistan } = await setUp();
    await routine(asistan.id, { whatsappPeople: true });
    await waitFor(async () => reads().people);
    const routines = t.services.routines;
    const batches: string[] = [];
    const real = routines.runFromWhatsApp.bind(routines);
    vi.spyOn(routines, 'runFromWhatsApp').mockImplementation(async (chat, batch, payloadFor) => {
      batches.push(batch);
      // The first offer finds a routine too busy.
      if (batches.length === 1) return { done: false, threads: {} };
      return real(chat, batch, payloadFor);
    });
    t.services.whatsapp.chatQuietMs = 300;
    wa.chat(`${CUSTOMER}@s.whatsapp.net`, { conversation: 'birinci' }, {}, 'Ahmet');
    await waitFor(async () => batches.length === 1);
    wa.chat(`${CUSTOMER}@s.whatsapp.net`, { conversation: 'ikinci' }, {}, 'Ahmet');
    await waitFor(async () => batches.length >= 3);
    expect(batches[1]).toBe(batches[0]);
    expect(batches[2]).not.toBe(batches[0]);
    const [chat] = await t.db.db.select().from(schema.whatsappChats);
    expect(chat!.heldSeq).toBeNull();
  });

  it('bir partinin metni sınırlıdır; kalan mesajlar sonraki partide gelir', async () => {
    const { wa, asistan } = await setUp();
    await routine(asistan.id, { whatsappPeople: true });
    await waitFor(async () => reads().people);
    const routines = t.services.routines;
    const sizes: number[] = [];
    vi.spyOn(routines, 'runFromWhatsApp').mockImplementation(async (_chat, _batch, payloadFor) => {
      sizes.push(payloadFor(asistan.id).length);
      return { done: true, threads: {} };
    });
    for (let i = 0; i < 20; i++)
      wa.chat(
        `${CUSTOMER}@s.whatsapp.net`,
        { conversation: `${i} ${'x'.repeat(3990)}` },
        { id: `uzun-${i}` },
      );
    await waitFor(async () => sizes.length >= 2);
    expect(Math.max(...sizes)).toBeLessThan(70_000);
  });

  it('bot yalnızca kendi rutinlerinin okuduğu sohbetleri görür', async () => {
    const { wa, asistan } = await setUp();
    const finans = await t.bot({ name: 'Finans' });
    wa.groups[GROUP] = { id: GROUP, subject: 'Finans' };
    await routine(asistan.id, { whatsappPeople: true });
    await routine(finans.id, { whatsappGroup: GROUP });
    await waitFor(async () => reads().people && reads().followed.has(GROUP));
    wa.chat(`${CUSTOMER}@s.whatsapp.net`, { conversation: 'özel konu' }, {}, 'Ahmet');
    wa.chat(GROUP, { conversation: 'ödeme geldi' }, { participant: `${CUSTOMER}@s.whatsapp.net` });
    await waitFor(async () => (await t.db.db.select().from(schema.whatsappChats)).length === 2);
    const wa_ = t.services.whatsapp;
    const ofFinans = await t.services.routines.whatsappReadsOf(finans.id);
    expect((await wa_.chats(10, ofFinans)).map((c) => c.jid)).toEqual([GROUP]);
    expect(await wa_.history(`${CUSTOMER}@s.whatsapp.net`, 10, finans.id, ofFinans)).toBeNull();
    expect(await wa_.knownChat(`${CUSTOMER}@s.whatsapp.net`, ofFinans)).toBeNull();
    const ofAsistan = await t.services.routines.whatsappReadsOf(asistan.id);
    expect((await wa_.chats(10, ofAsistan)).map((c) => c.jid)).toEqual([`${CUSTOMER}@s.whatsapp.net`]);
  });

  it('sohbetten bir grubu takibe alır; tam erişimde de önce kart sorar, "Hayır" bir şey değiştirmez', async () => {
    const { wa } = await setUp();
    wa.groups[GROUP] = { id: GROUP, subject: '3E Soğutma - Finans' };
    const finans = await t.bot({ name: 'Finans', permissionMode: 'auto' });
    const r = await routine(finans.id, {});
    const thread = (await t.api<Thread>('GET', `/api/bots/${finans.id}/main-thread`)).body;
    const follow = (group: string) => `[araç:whatsapp_follow {"routine":"Gelenler","group":"${group}"}]`;
    const card = () =>
      waitFor(async () =>
        (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body.find(
          (a) => a.toolName === 'ask_user',
        ),
      );
    await t.send(thread.id, follow('finans'));
    const first = await card();
    expect(first.summary).toContain('Gelenler');
    expect(JSON.stringify(first.input)).toContain('3E Soğutma - Finans');
    await t.api('POST', `/api/approvals/${first.id}`, { decision: 'allow', answer: 'Hayır' });
    await t.services.turns.idle();
    expect((await t.services.routines.get(r.id)).whatsappGroup).toBeNull();

    await t.send(thread.id, follow('finans'));
    const second = await card();
    await t.api('POST', `/api/approvals/${second.id}`, { decision: 'allow', answer: 'Evet, okusun' });
    await t.services.turns.idle();
    expect((await t.services.routines.get(r.id)).whatsappGroup).toBe(GROUP);
    await waitFor(async () => reads().followed.has(GROUP));
    expect((await t.messages(thread.id)).map((m) => m.text).join('\n')).toContain(
      '“3E Soğutma - Finans” grubu',
    );

    // Stopping needs no card.
    await t.send(thread.id, follow(''));
    await t.services.turns.idle();
    expect((await t.services.routines.get(r.id)).whatsappGroup).toBeNull();
    expect((await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body).toEqual([]);
  });

  it('sohbette WhatsApp’a bakmak önce kart sorar; izinle her sohbet saklanır ve okunur, rutin başlamaz', async () => {
    const { wa, asistan } = await setUp();
    wa.groups[GROUP] = { id: GROUP, subject: 'Aile' };
    const thread = (await t.api<Thread>('GET', `/api/bots/${asistan.id}/main-thread`)).body;
    const card = () =>
      waitFor(async () =>
        (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body.find(
          (a) => a.toolName === 'ask_user',
        ),
      );
    // No routine reads WhatsApp: the bot has the tools anyway, and asks before the first look.
    await t.send(thread.id, '[araç:whatsapp_chats {}]');
    const first = await card();
    await t.api('POST', `/api/approvals/${first.id}`, { decision: 'allow', answer: 'Hayır' });
    await t.services.turns.idle();
    expect((await t.api<WhatsAppStatus>('GET', '/api/whatsapp')).body.chats).toBe(false);
    expect(wa.options().ignore(GROUP)).toBe(true);

    await t.send(thread.id, '[araç:whatsapp_chats {}]');
    const second = await card();
    await t.api('POST', `/api/approvals/${second.id}`, { decision: 'allow', answer: 'Evet, okusun' });
    await t.services.turns.idle();
    expect((await t.api<WhatsAppStatus>('GET', '/api/whatsapp')).body.chats).toBe(true);
    expect((await t.messages(thread.id)).map((m) => m.text).join('\n')).toContain(
      'Henüz saklanan WhatsApp sohbeti yok',
    );
    expect(wa.options().ignore(GROUP)).toBe(false);

    wa.chat(`${CUSTOMER}@s.whatsapp.net`, { conversation: 'Akşam geliyor musun?' }, {}, 'Ahmet');
    wa.chat(
      GROUP,
      { imageMessage: { caption: 'Tatil fotoğrafı', mimetype: 'image/jpeg' } },
      { participant: `${CUSTOMER}@s.whatsapp.net` },
    );
    await waitFor(async () => (await t.db.db.select().from(schema.whatsappMessages)).length === 2);
    await t.send(thread.id, `[araç:whatsapp_history {"chat":"${CUSTOMER}@s.whatsapp.net"}]`);
    await t.send(thread.id, `[araç:whatsapp_history {"chat":"${GROUP}"}]`);
    await t.services.turns.idle();
    const said = (await t.messages(thread.id)).map((m) => m.text).join('\n');
    expect(said).toContain('Akşam geliyor musun?');
    expect(said).toContain('Tatil fotoğrafı');
    // A chat no routine reads keeps no files and starts no run; its place moves on at once.
    expect(said).toContain('dosyalar yalnızca bir rutinin okuduğu sohbetlerde saklanır');
    expect(existsSync(join(t.dataDir, 'workspaces', 'bots', asistan.id, 'files', 'whatsapp'))).toBe(false);
    expect(await t.db.db.select().from(schema.routineRuns)).toEqual([]);
    const chats = await t.db.db.select().from(schema.whatsappChats);
    const messages = await t.db.db.select().from(schema.whatsappMessages);
    for (const c of chats) {
      expect(c.batchedSeq).toBe(Math.max(...messages.filter((m) => m.chat === c.jid).map((m) => m.seq)));
    }
    // Writing to the group is still not done.
    await t.send(thread.id, `[araç:whatsapp_send {"chat":"${GROUP}","text":"selam"}]`);
    await t.services.turns.idle();
    expect((await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body).toEqual([]);
  });

  it('bot, hiç yazmamış bir numaraya kartla mesaj taslağı hazırlar; WhatsApp’ta olmayana hazırlamaz', async () => {
    const { wa, asistan } = await setUp();
    await t.api('PUT', '/api/whatsapp', { mode: 'own', phone: PERSON, botId: asistan.id, chats: true });
    wa.onWa.add('905004445566');
    const thread = (await t.api<Thread>('GET', `/api/bots/${asistan.id}/main-thread`)).body;
    await t.send(thread.id, '[araç:whatsapp_send {"chat":"+90 500 111 0000","text":"Merhaba"}]');
    await t.services.turns.idle();
    expect((await t.messages(thread.id)).map((m) => m.text).join('\n')).toContain(
      'WhatsApp kullanmıyor: +905001110000',
    );
    await t.send(
      thread.id,
      '[araç:whatsapp_send {"chat":"+90 500 444 55 66","text":"Yarın 10’da uygun musunuz?"}]',
    );
    const card = await waitFor(async () =>
      (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body.find(
        (a) => a.toolName === 'whatsapp_send',
      ),
    );
    expect(card.summary).toContain('+905004445566');
    expect(wa.sent.filter((x) => x.jid.startsWith('905004445566'))).toHaveLength(0);
    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'allow', answer: 'Gönder' });
    await waitFor(async () => wa.sent.some((x) => x.jid === '905004445566@s.whatsapp.net'));
    expect(wa.sent.find((x) => x.jid === '905004445566@s.whatsapp.net')!.content.text).toBe(
      'Yarın 10’da uygun musunuz?',
    );
    // Saving the form without the switch keeps it as it is.
    await t.api('PUT', '/api/whatsapp', { mode: 'own', phone: PERSON, botId: asistan.id });
    expect((await t.api<WhatsAppStatus>('GET', '/api/whatsapp')).body.chats).toBe(true);
  });

  it('aynı turda sohbeti okuyup cevap taslağı hazırlar', async () => {
    const { wa, asistan } = await setUp();
    await t.api('PUT', '/api/whatsapp', { mode: 'own', phone: PERSON, botId: asistan.id, chats: true });
    wa.chat(`${CUSTOMER}@s.whatsapp.net`, { conversation: 'Akşam geliyor musun?' }, {}, 'Ahmet');
    await waitFor(async () => (await t.db.db.select().from(schema.whatsappMessages)).length === 1);
    const thread = (await t.api<Thread>('GET', `/api/bots/${asistan.id}/main-thread`)).body;
    await t.send(
      thread.id,
      `[araç:whatsapp_history {"chat":"${CUSTOMER}@s.whatsapp.net"}] [araç:whatsapp_send {"chat":"${CUSTOMER}@s.whatsapp.net","text":"Geliyorum"}]`,
    );
    const card = await waitFor(async () =>
      (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body.find(
        (a) => a.toolName === 'whatsapp_send',
      ),
    );
    expect(card.summary).toContain('Ahmet (905001112233)');
    expect(card.summary).toContain('Geliyorum');
  });

  it('dışarıdan başlayan bir çalışma, izin açıkken de rutinlerin okumadığı sohbete bakamaz', async () => {
    const { wa, asistan } = await setUp();
    wa.groups[GROUP] = { id: GROUP, subject: 'Finans' };
    await t.api('PUT', '/api/whatsapp', { mode: 'own', phone: PERSON, botId: asistan.id, chats: true });
    wa.chat(`${CUSTOMER}@s.whatsapp.net`, { conversation: 'özel konu' }, {}, 'Ahmet');
    await waitFor(async () => (await t.db.db.select().from(schema.whatsappMessages)).length === 1);
    // A group message starts this run: nobody asked for it, so it sees only the group it follows.
    const r = await routine(asistan.id, {
      whatsappGroup: GROUP,
      prompt: `[araç:whatsapp_history {"chat":"${CUSTOMER}@s.whatsapp.net"}] [araç:whatsapp_chats {}]`,
    });
    await waitFor(async () => reads().followed.has(GROUP));
    wa.chat(GROUP, { conversation: 'ödeme geldi' }, { participant: `${CUSTOMER}@s.whatsapp.net` });
    const [run] = await runs(r.id);
    await t.services.turns.idle();
    const said = (await t.messages(run!.threadId!)).map((m) => m.text).join('\n');
    expect(said).toContain('Bu WhatsApp sohbeti burada saklanmıyor');
    expect(said).not.toContain('özel konu');
    expect(said).not.toContain(`${CUSTOMER}@s.whatsapp.net · person`);
    expect((await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body).toEqual([]);
  });

  it('izinle saklanan eski mesajlar, sonradan açılan rutine yeni diye gitmez', async () => {
    const { wa, asistan } = await setUp();
    await t.api('PUT', '/api/whatsapp', { mode: 'own', phone: PERSON, botId: asistan.id, chats: true });
    wa.chat(`${CUSTOMER}@s.whatsapp.net`, { conversation: 'eski konu' }, {}, 'Ahmet');
    await waitFor(async () => (await t.db.db.select().from(schema.whatsappMessages)).length === 1);
    const r = await routine(asistan.id, { whatsappPeople: true });
    await waitFor(async () => reads().people);
    wa.chat(`${CUSTOMER}@s.whatsapp.net`, { conversation: 'yeni konu' }, {}, 'Ahmet');
    await runs(r.id);
    await t.services.turns.idle();
    const prompt = t.engine.requests.at(-1)!.prompt;
    const fresh = prompt.slice(prompt.indexOf('Yeni mesajlar:'));
    expect(fresh).toContain('yeni konu');
    expect(fresh).not.toContain('eski konu');
  });

  it('WhatsApp başkası tarafından bağlanınca öncekinin rutinleri onu okumaz', async () => {
    const { asistan } = await setUp();
    await routine(asistan.id, { whatsappPeople: true });
    expect((await t.services.routines.whatsappReads()).people).toBe(true);
    const other = await t.person('ayse', 'admin');
    await t.db.db
      .update(schema.channels)
      .set({ userId: other.id })
      .where(eq(schema.channels.kind, 'whatsapp'));
    expect((await t.services.routines.whatsappReads()).people).toBe(false);
    expect([...(await t.services.routines.whatsappBots())]).toEqual([]);
    expect(await t.services.routines.chatReaders(`${CUSTOMER}@s.whatsapp.net`, 'person')).toEqual([]);
  });

  it('gruba taslak yazılmaz; Durum taslağı kartla sunulur ve onayla paylaşılır', async () => {
    const { wa, asistan } = await setUp();
    wa.groups[GROUP] = { id: GROUP, subject: 'Finans' };
    const r = await routine(asistan.id, {
      whatsappGroup: GROUP,
      whatsappPeople: true,
      prompt: [
        `[araç:whatsapp_send {"chat":"${GROUP}","text":"tamam"}]`,
        '[araç:whatsapp_send {"chat":"x@s.whatsapp.net","text":"tamam","file":"/etc/hosts"}]',
        '[araç:whatsapp_status {"text":"Yeni ürünümüz çıktı"}]',
      ].join(' '),
    });
    await waitFor(async () => reads().followed.has(GROUP));
    // Someone to see the Status.
    wa.chat(`${CUSTOMER}@s.whatsapp.net`, { conversation: 'iyi günler' }, {}, 'Ahmet');
    await runs(r.id);
    await t.services.turns.idle();
    const cards = (await t.api<Approval[]>('GET', '/api/approvals')).body;
    expect(cards.filter((a) => a.toolName === 'whatsapp_send')).toHaveLength(0);
    const status = cards.find((a) => a.toolName === 'whatsapp_status')!;
    expect(status.summary).toContain('1 kişi görecek');
    await t.api('POST', `/api/approvals/${status.id}`, { decision: 'allow', answer: 'Paylaş' });
    await waitFor(async () => wa.sent.some((x) => x.jid === 'status@broadcast'));
    expect(wa.sent.filter((x) => x.jid.endsWith('@g.us'))).toHaveLength(0);
  });

  it('rutinin kendi çalıştırması müşteri sohbetinin konuşmasına düşmez', async () => {
    const { wa, asistan } = await setUp();
    const r = await routine(asistan.id, { whatsappPeople: true });
    await waitFor(async () => reads().people);
    wa.chat(`${CUSTOMER}@s.whatsapp.net`, { conversation: 'merhaba' }, {}, 'Ahmet');
    const [first] = await runs(r.id);
    await t.services.turns.idle();
    const own = await t.api<RoutineRun>('POST', `/api/routines/${r.id}/run`);
    expect(own.status).toBe(200);
    await t.services.turns.idle();
    const all = (await t.api<RoutineRun[]>('GET', `/api/routines/${r.id}/runs`)).body;
    const manual = all.find((x) => !x.occurrence.startsWith('wa:'))!;
    expect(manual.threadId).not.toBe(first!.threadId);
  });

  it('30 günden eski mesajlar dosyalarıyla silinir', async () => {
    const { wa, asistan } = await setUp();
    await routine(asistan.id, { whatsappPeople: true });
    await waitFor(async () => reads().people);
    wa.chat(
      `${CUSTOMER}@s.whatsapp.net`,
      { imageMessage: { caption: 'katalog', mimetype: 'image/jpeg' } },
      {},
      'Ahmet',
    );
    const [msg] = await waitFor(async () => {
      const rows = await t.db.db.select().from(schema.whatsappMessages);
      return rows[0]?.file ? rows : undefined;
    });
    const file = msg!.file as { name: string };
    const path = join(t.dataDir, 'workspaces', 'bots', asistan.id, 'files', 'whatsapp', CUSTOMER, file.name);
    expect(existsSync(path)).toBe(true);
    // A settled draft goes too; one whose card is still open stays.
    const draft = { approvalId: 'kart', botId: asistan.id, threadId: 'konusma', kind: 'message' as const };
    await t.db.db.insert(schema.whatsappDrafts).values([
      { ...draft, id: 'gitti', text: 'eski cevap', approve: 'Gönder', status: 'sent' },
      { ...draft, id: 'bekliyor', text: 'açık kart', approve: 'Gönder' },
    ]);
    await t.services.whatsapp.prune(new Date(Date.now() + 31 * 24 * 3600_000));
    expect((await t.db.db.select().from(schema.whatsappDrafts)).map((d) => d.id)).toEqual(['bekliyor']);
    expect(await t.db.db.select().from(schema.whatsappMessages)).toHaveLength(0);
    expect(await t.db.db.select().from(schema.whatsappChats)).toHaveLength(0);
    expect(existsSync(path)).toBe(false);
  });

  it('WhatsApp okuyan rutini yalnızca WhatsApp’ı bağlayan kişi kurar', async () => {
    const { asistan } = await setUp();
    const other = await t.person('ayse', 'admin');
    const r = await other.api('POST', '/api/routines', {
      botId: asistan.id,
      name: 'Gizli okuma',
      prompt: 'oku',
      schedule: { type: 'daily', time: '09:00' },
      whatsappPeople: true,
    });
    expect(r.status).toBe(403);
    expect((await other.api('GET', '/api/whatsapp/groups')).status).toBe(403);
  });
});

describe('WhatsApp grubunu adla seçme', () => {
  it('grup adla bulunur: önce tam ad, yoksa adında geçen tek grup', () => {
    const groups = [
      { id: '1@g.us', name: '3E Soğutma - Finans' },
      { id: '2@g.us', name: 'Finans' },
      { id: '3@g.us', name: '3E Soğutma - Üretim' },
    ];
    expect(pickGroup(groups, 'finans')).toEqual({ group: groups[1] });
    expect(pickGroup(groups, '3e soğutma - FİNANS')).toEqual({ group: groups[0] });
    expect(pickGroup(groups, 'üretim')).toEqual({ group: groups[2] });
    expect(pickGroup(groups, '3E Soğutma')).toEqual({ many: ['3E Soğutma - Finans', '3E Soğutma - Üretim'] });
    expect(pickGroup(groups, '2@g.us')).toEqual({ group: groups[1] });
    expect(pickGroup(groups, 'muhasebe')).toBeNull();
  });
});
