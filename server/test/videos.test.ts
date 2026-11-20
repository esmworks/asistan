import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Message, MessageFile, Thread } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isMp4, VideoService } from '../src/services/videos';
import { testServer, type TestServer } from './helpers';

/** The start of an MP4 file: a `ftyp` box, then a little of anything. */
const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  Buffer.from('ftypisom', 'latin1'),
  Buffer.alloc(32, 1),
]);

interface Sent {
  url: string;
  method: string;
  auth: string | null;
  body: Record<string, unknown> | null;
}

describe('the bot making a video', () => {
  let t: TestServer;
  let sent: Sent[];
  let slept: number[];
  beforeEach(async () => {
    t = await testServer();
    sent = [];
    slept = [];
  });
  afterEach(() => t.dispose());

  /** Answers like the provider would; each test says how. Waiting between asks takes no time. */
  const useProvider = (answer: (url: string, n: number) => Response) => {
    const fake = (async (url: string, init: RequestInit = {}) => {
      sent.push({
        url,
        method: init.method ?? 'GET',
        auth: new Headers(init.headers).get('authorization'),
        body: typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      });
      return answer(url, sent.length);
    }) as typeof fetch;
    const sleep = async (ms: number) => {
      slept.push(ms);
    };
    (t.services as { videos: VideoService }).videos = new VideoService(t.services.keys, fake, sleep);
  };
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const create = async (threadId: string, input: Record<string, unknown>) => {
    await t.send(threadId, `[araç:video_create ${JSON.stringify(input)}]`);
    await t.services.turns.idle();
    return t.messages(threadId);
  };
  const fileCards = (msgs: Message[]) =>
    msgs.filter((m) => m.role === 'assistant' && Array.isArray(m.props.files));

  it('starts a job, asks until it is done, fetches the video without the key and sends it as a file', async () => {
    await t.services.keys.set('xai', 'xai-test-video-1234');
    useProvider((url, n) => {
      if (url === 'https://api.x.ai/v1/videos/generations') return json({ request_id: 'job-1' });
      if (url === 'https://api.x.ai/v1/videos/job-1')
        return n < 4
          ? json({ status: 'pending' })
          : json({ status: 'done', video: { url: 'https://vidgen.x.ai/r/v.mp4', respect_moderation: true } });
      return new Response(new Uint8Array(MP4));
    });
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = await main(bot.id);
    const msgs = await create(thread.id, {
      prompt: 'Sahilde gün batımı',
      seconds: 8,
      shape: 'portrait',
      caption: 'Sahil',
    });

    expect(sent[0]).toEqual({
      url: 'https://api.x.ai/v1/videos/generations',
      method: 'POST',
      auth: 'Bearer xai-test-video-1234',
      body: {
        model: 'grok-imagine-video-1.5',
        prompt: 'Sahilde gün batımı',
        duration: 8,
        aspect_ratio: '9:16',
        resolution: '720p',
      },
    });
    expect(sent.filter((s) => s.url.endsWith('/job-1'))).toHaveLength(3);
    expect(slept.every((ms) => ms === 5_000)).toBe(true);
    const download = sent.at(-1)!;
    expect(download).toMatchObject({ url: 'https://vidgen.x.ai/r/v.mp4', auth: null });

    const [card] = fileCards(msgs);
    expect(card!.text).toBe('Sahil');
    const [file] = card!.props.files as MessageFile[];
    expect(file!.name).toMatch(/^video-\d{4}-\d{2}-\d{2}-\d{6}\.mp4$/);
    expect(readFileSync(join(t.dataDir, 'workspaces', file!.path))).toEqual(MP4);
    expect(msgs.at(-1)!.text).toContain('8 saniyelik video oluşturuldu (xai)');
  });

  it('says which key is missing, and passes on a failed job, a filtered video and a wrong file without the key', async () => {
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = await main(bot.id);
    let msgs = await create(thread.id, { prompt: 'Bir şey' });
    expect(msgs.at(-1)!.text).toContain('xAI API anahtarı yok');

    await t.services.keys.set('xai', 'xai-test-video-1234');
    useProvider((url) =>
      url.endsWith('/generations')
        ? json({ request_id: 'j' })
        : json({ status: 'failed', error: { code: 'invalid_argument', message: 'bad xai-test-video-1234' } }),
    );
    msgs = await create(thread.id, { prompt: 'İkinci' });
    expect(msgs.at(-1)!.text).toContain('videoyu oluşturamadı: bad ***');

    useProvider((url) =>
      url.endsWith('/generations')
        ? json({ request_id: 'j' })
        : json({ status: 'done', video: { url: 'https://vidgen.x.ai/v.mp4', respect_moderation: false } }),
    );
    msgs = await create(thread.id, { prompt: 'Üçüncü' });
    expect(msgs.at(-1)!.text).toContain('içerik kuralları');

    useProvider((url) =>
      url.endsWith('/generations')
        ? json({ request_id: 'j' })
        : url.endsWith('/j')
          ? json({ status: 'done', video: { url: 'https://vidgen.x.ai/v.mp4' } })
          : new Response('<html>nope</html>'),
    );
    msgs = await create(thread.id, { prompt: 'Dördüncü' });
    expect(msgs.at(-1)!.text).toContain('video yerine başka bir şey');
    expect(fileCards(msgs)).toEqual([]);
  });

  it('makes one video in a turn', async () => {
    await t.services.keys.set('xai', 'xai-test-video-1234');
    useProvider((url) =>
      url.endsWith('/generations')
        ? json({ request_id: 'j' })
        : url.endsWith('/j')
          ? json({ status: 'done', video: { url: 'https://vidgen.x.ai/v.mp4' } })
          : new Response(new Uint8Array(MP4)),
    );
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = await main(bot.id);
    await t.send(thread.id, '[araç:video_create {"prompt":"bir"}] [araç:video_create {"prompt":"iki"}]');
    await t.services.turns.idle();
    expect(sent.filter((s) => s.url.endsWith('/generations'))).toHaveLength(1);
  });

  it('knows an MP4 by its first box', () => {
    expect(isMp4(MP4)).toBe(true);
    expect(isMp4(Buffer.from('<html></html>xxxxxxxx'))).toBe(false);
  });
});
