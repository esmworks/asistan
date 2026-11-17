import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Approval, Message, MessageFile, Thread } from '@yumakbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ImageService, imageType, MAX_IMAGE_BYTES } from '../src/services/images';
import { MAX_IMAGES_PER_TURN } from '../src/tools/images';
import { testServer, waitFor, type TestServer } from './helpers';

/** The smallest valid PNG: a 1×1 transparent pixel. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

interface Sent {
  url: string;
  auth: string | null;
  body: Record<string, unknown> | null;
}

describe('botun resim oluşturması', () => {
  let t: TestServer;
  let sent: Sent[];
  beforeEach(async () => {
    t = await testServer();
    sent = [];
  });
  afterEach(() => t.dispose());

  /** Answers like a provider would; each test says how. */
  const useProvider = (answer: (url: string) => Response | Promise<Response>) => {
    const fake = (async (url: string, init: RequestInit = {}) => {
      sent.push({
        url,
        auth: new Headers(init.headers).get('authorization'),
        body: typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      });
      return answer(url);
    }) as typeof fetch;
    (t.services as { images: ImageService }).images = new ImageService(t.services.keys, fake);
  };
  const b64 = (data = PNG) => new Response(JSON.stringify({ data: [{ b64_json: data.toString('base64') }] }));

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const create = async (threadId: string, input: Record<string, unknown>) => {
    await t.send(threadId, `[araç:image_create ${JSON.stringify(input)}]`);
    await t.services.turns.idle();
    return t.messages(threadId);
  };
  const fileCards = (msgs: Message[]) =>
    msgs.filter((m) => m.role === 'assistant' && Array.isArray(m.props.files));

  it('kayıtlı OpenAI anahtarıyla resmi yapar, sohbet klasörüne kaydeder ve kart olarak gönderir', async () => {
    await t.services.keys.set('openai', 'sk-test-image-1234');
    useProvider(() => b64());
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = await main(bot.id);
    const msgs = await create(thread.id, {
      prompt: 'Ay ışığında bir kedi',
      shape: 'landscape',
      caption: 'Kedi',
    });

    expect(sent).toEqual([
      {
        url: 'https://api.openai.com/v1/images/generations',
        auth: 'Bearer sk-test-image-1234',
        body: { model: 'gpt-image-2', prompt: 'Ay ışığında bir kedi', n: 1, size: '1536x1024' },
      },
    ]);
    const [card] = fileCards(msgs);
    expect(card!.text).toBe('Kedi');
    const [file] = card!.props.files as MessageFile[];
    expect(file!.name).toMatch(/^resim-\d{4}-\d{2}-\d{2}-\d{6}\.png$/);
    expect(file!.path).toBe(`bots/${bot.id}/threads/${thread.id}/${file!.name}`);
    expect(readFileSync(join(t.dataDir, 'workspaces', file!.path))).toEqual(PNG);
    expect(msgs.at(-1)!.text).toContain('Resim oluşturuldu (openai)');
  });

  it('xAI anahtarıyla en-boy oranını ve base64 yanıtı ister; adres dönerse resmi oradan indirir', async () => {
    await t.services.keys.set('xai', 'xai-test-image-1234');
    useProvider((url) =>
      url.startsWith('https://api.x.ai/')
        ? new Response(JSON.stringify({ data: [{ url: 'https://imgen.x.ai/r/abc.png' }] }))
        : new Response(new Uint8Array(PNG)),
    );
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = await main(bot.id);
    const msgs = await create(thread.id, { prompt: 'Bir dağ manzarası', shape: 'portrait' });

    expect(sent[0]).toEqual({
      url: 'https://api.x.ai/v1/images/generations',
      auth: 'Bearer xai-test-image-1234',
      body: {
        model: 'grok-imagine-image-2.0',
        prompt: 'Bir dağ manzarası',
        n: 1,
        aspect_ratio: '2:3',
        response_format: 'b64_json',
      },
    });
    expect(sent[1]!.url).toBe('https://imgen.x.ai/r/abc.png');
    expect(fileCards(msgs)).toHaveLength(1);
  });

  it('botun kendi sağlayıcısını öne alır', async () => {
    await t.services.keys.set('openai', 'sk-test-image-1234');
    await t.services.keys.set('xai', 'xai-test-image-1234');
    useProvider(() => b64());
    await t.services.images.create('bir şey', { prefer: 'xai' });
    await t.services.images.create('bir şey');
    expect(sent.map((s) => new URL(s.url).host)).toEqual(['api.x.ai', 'api.openai.com']);
  });

  it('anahtar yokken istek yapmaz, bota hangi anahtarın gerektiğini söyler', async () => {
    useProvider(() => b64());
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = await main(bot.id);
    const msgs = await create(thread.id, { prompt: 'Bir kedi' });
    expect(sent).toHaveLength(0);
    expect(fileCards(msgs)).toHaveLength(0);
    expect(msgs.at(-1)!.text).toContain('OpenAI ya da xAI API anahtarı yok');
  });

  it('internet kapalı botta araç yoktur', async () => {
    const bot = await t.bot({ permissionMode: 'auto', internet: false });
    const thread = await main(bot.id);
    await t.send(thread.id, 'merhaba');
    await t.services.turns.idle();
    expect(t.engine.requests.at(-1)!.tools.map((x) => x.name)).not.toContain('image_create');
  });

  it('resim olmayan ya da çok büyük yanıtı kaydetmez', async () => {
    await t.services.keys.set('openai', 'sk-test-image-1234');
    useProvider(() => b64(Buffer.from('<html>bir hata sayfası</html>')));
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = await main(bot.id);
    const msgs = await create(thread.id, { prompt: 'Bir kedi' });
    expect(fileCards(msgs)).toHaveLength(0);
    expect(msgs.at(-1)!.text).toContain('resim yerine başka bir şey döndürdü');

    useProvider(() => b64(Buffer.concat([PNG, Buffer.alloc(21 * 1024 * 1024)])));
    await expect(t.services.images.create('Bir kedi')).rejects.toMatchObject({ reason: 'tooLarge' });
  });

  it('stops reading a picture address that sends no size and does not end', async () => {
    await t.services.keys.set('xai', 'xai-test-image-1234');
    let pulled = 0;
    // No content-length, and more bytes for as long as anyone reads.
    const endless = () =>
      new ReadableStream<Uint8Array>({
        pull(c) {
          pulled += 1024 * 1024;
          c.enqueue(new Uint8Array(1024 * 1024));
        },
      });
    useProvider((url) =>
      url.startsWith('https://api.x.ai/')
        ? new Response(JSON.stringify({ data: [{ url: 'https://imgen.x.ai/r/big.png' }] }))
        : new Response(endless()),
    );
    await expect(t.services.images.create('Bir kedi')).rejects.toMatchObject({ reason: 'tooLarge' });
    expect(pulled).toBeLessThan(MAX_IMAGE_BYTES + 4 * 1024 * 1024);
  });

  it('sağlayıcının hatasını anahtarı göstermeden bota iletir', async () => {
    await t.services.keys.set('openai', 'sk-test-image-1234');
    useProvider(
      () =>
        new Response(
          JSON.stringify({ error: { message: 'Incorrect API key provided: sk-test-image-1234' } }),
          {
            status: 401,
          },
        ),
    );
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = await main(bot.id);
    const reply = (await create(thread.id, { prompt: 'Bir kedi' })).at(-1)!.text;
    expect(reply).toContain('openai resmi oluşturamadı: Incorrect API key provided');
    expect(reply).not.toContain('sk-test-image-1234');
  });

  it(`bir turda en çok ${MAX_IMAGES_PER_TURN} resim yapar`, async () => {
    await t.services.keys.set('openai', 'sk-test-image-1234');
    useProvider(() => b64());
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = await main(bot.id);
    await t.send(thread.id, 'kedi resimleri');
    await t.services.turns.idle();
    // The turn's own tool, called as many times as a looping model would.
    const tool = t.engine.requests.at(-1)!.tools.find((x) => x.name === 'image_create')!;
    const replies: unknown[] = [];
    for (let i = 0; i <= MAX_IMAGES_PER_TURN; i++) replies.push(await tool.handler({ prompt: 'Bir kedi' }));
    expect(sent).toHaveLength(MAX_IMAGES_PER_TURN);
    expect(fileCards(await t.messages(thread.id))).toHaveLength(MAX_IMAGES_PER_TURN);
    expect(replies.at(-1)).toContain(`en çok ${MAX_IMAGES_PER_TURN} resim`);
  });

  it('soran botta resim yapmadan önce kart açar', async () => {
    await t.services.keys.set('openai', 'sk-test-image-1234');
    useProvider(() => b64());
    const bot = await t.bot({ name: 'Ressam' });
    const thread = await main(bot.id);
    await t.send(thread.id, '[araç:image_create {"prompt":"Bir kedi"}]');
    const card = await waitFor(
      async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body[0],
    );
    expect(card.summary).toContain('Ressam bir resim oluşturmak istiyor');
    expect(sent).toHaveLength(0);
    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'allow' });
    await t.services.turns.idle();
    expect(sent).toHaveLength(1);
  });

  it('resmin biçimini ilk baytlarından tanır', () => {
    expect(imageType(PNG)).toBe('png');
    expect(imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg');
    expect(imageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp');
    expect(imageType(Buffer.from('GIF89a'))).toBe('gif');
    expect(imageType(Buffer.from('{"error":1}'))).toBeNull();
  });
});
