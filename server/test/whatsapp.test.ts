import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { Approval, Thread, WhatsAppStatus } from '@yumakbot/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { WaLibrary, WaMessage, WaSocket } from '../src/channels/whatsapp';
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
  const lib: WaLibrary = {
    connect: () => {
      const ev = new EventEmitter();
      socket = {
        ev: ev as unknown as WaSocket['ev'],
        user: null,
        emit: (e, v) => ev.emit(e, v),
        sendMessage: async (jid, content) => {
          const id = `sent-${++n}`;
          sent.push({ jid, content, id });
          return { key: { id } };
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
    download: async () => Readable.from([Buffer.from('ses kaydı')]),
    loggedOut: 401,
  };
  return {
    lib,
    sent,
    presence,
    socket: () => socket!,
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
