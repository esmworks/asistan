import { BodyTooLarge, readCapped } from './read-capped';
import { redactSecrets } from './secrets';
import type { ProviderKeyService } from './keys';

/** The shape the bot asks for, in the provider's terms. */
export type VideoShape = 'landscape' | 'portrait' | 'square';

/**
 * The provider that turns a prompt into a short video, through a key the person saved. It works
 * as a job: the request gives an id, the job is asked about until it is done, and the finished
 * video is fetched from a temporary address.
 */
const SERVICE = {
  provider: 'xai',
  create: 'https://api.x.ai/v1/videos/generations',
  job: (id: string) => `https://api.x.ai/v1/videos/${encodeURIComponent(id)}`,
  model: 'grok-imagine-video-1.5',
  aspect: { landscape: '16:9', portrait: '9:16', square: '1:1' } as Record<VideoShape, string>,
  resolution: '720p',
} as const;

export const VIDEO_PROVIDERS: readonly string[] = [SERVICE.provider];
/** Lengths the provider makes, in seconds. */
export const VIDEO_SECONDS = { min: 1, max: 15, default: 6 } as const;
/** A 15-second 720p clip is a few tens of megabytes; anything far bigger is not what was asked for. */
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
/** How often the job is asked about, and how long it may take in all. */
const POLL_MS = 5_000;
const TIMEOUT_MS = 10 * 60_000;

/** Why a video could not be made, in words the bot passes on. */
export class VideoError extends Error {
  constructor(
    readonly reason: 'noKey' | 'failed' | 'filtered' | 'notVideo' | 'tooLarge' | 'timeout',
    message = '',
    readonly provider = '',
  ) {
    super(message);
  }
}

export interface CreatedVideo {
  data: Buffer;
  provider: string;
  seconds: number;
}

/** An MP4 file: its first box is `ftyp`. */
export const isMp4 = (data: Buffer) => data.length > 12 && data.subarray(4, 8).toString('latin1') === 'ftyp';

type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

const sleepFor: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      },
      { once: true },
    );
  });

export class VideoService {
  constructor(
    private keys: ProviderKeyService,
    private fetcher: typeof fetch = fetch,
    private sleep: Sleep = sleepFor,
    private clock: () => number = Date.now,
  ) {}

  async available(): Promise<boolean> {
    return !!(await this.keys.get(SERVICE.provider));
  }

  async create(
    prompt: string,
    opts: { seconds?: number; shape?: VideoShape; signal?: AbortSignal } = {},
  ): Promise<CreatedVideo> {
    const key = await this.keys.get(SERVICE.provider);
    if (!key) throw new VideoError('noKey');
    const provider = SERVICE.provider;
    const signal = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(opts.signal ? [opts.signal] : [])]);
    const fail = (message: string): never => {
      // A provider may echo the request back; the key must not reach the bot or the chat.
      throw new VideoError('failed', redactSecrets(message.replaceAll(key, '***'), '***').text, provider);
    };
    const call = async (url: string, init: RequestInit = {}) => {
      try {
        return await this.fetcher(url, {
          ...init,
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          signal,
        });
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        if (signal.aborted) throw new VideoError('timeout', '', provider);
        return fail(err instanceof Error ? err.message : String(err));
      }
    };
    const errorOf = (body: unknown, status: number) => {
      const e = (body as { error?: { message?: unknown } | string } | null)?.error;
      return String((typeof e === 'string' ? e : e?.message) ?? `HTTP ${status}`);
    };

    const seconds = Math.min(
      VIDEO_SECONDS.max,
      Math.max(VIDEO_SECONDS.min, Math.round(opts.seconds ?? VIDEO_SECONDS.default)),
    );
    const started = await call(SERVICE.create, {
      method: 'POST',
      body: JSON.stringify({
        model: SERVICE.model,
        prompt,
        duration: seconds,
        aspect_ratio: SERVICE.aspect[opts.shape ?? 'landscape'],
        resolution: SERVICE.resolution,
      }),
    });
    const startBody = (await started.json().catch(() => null)) as { request_id?: unknown } | null;
    if (!started.ok || typeof startBody?.request_id !== 'string')
      return fail(errorOf(startBody, started.status));
    const id = startBody.request_id;

    const deadline = this.clock() + TIMEOUT_MS;
    let url: string | null = null;
    while (!url) {
      if (this.clock() > deadline) throw new VideoError('timeout', '', provider);
      try {
        await this.sleep(POLL_MS, signal);
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        throw new VideoError('timeout', '', provider);
      }
      const res = await call(SERVICE.job(id));
      const body = (await res.json().catch(() => null)) as {
        status?: unknown;
        video?: { url?: unknown; respect_moderation?: unknown };
      } | null;
      if (!res.ok) return fail(errorOf(body, res.status));
      if (body?.status === 'pending') continue;
      if (body?.status !== 'done') return fail(errorOf(body, res.status));
      // The provider's own filter held the video back.
      if (body.video?.respect_moderation === false) throw new VideoError('filtered', '', provider);
      if (typeof body.video?.url !== 'string' || !body.video.url.startsWith('https://')) {
        throw new VideoError('notVideo', '', provider);
      }
      url = body.video.url;
    }

    // The address is the provider's temporary file; it is fetched without the key.
    let file: Response;
    try {
      file = await this.fetcher(url, { signal });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      return fail(err instanceof Error ? err.message : String(err));
    }
    if (!file.ok) return fail(`HTTP ${file.status}`);
    if (Number(file.headers.get('content-length') ?? 0) > MAX_VIDEO_BYTES) {
      throw new VideoError('tooLarge', '', provider);
    }
    let data: Buffer;
    try {
      data = await readCapped(file.body, MAX_VIDEO_BYTES);
    } catch (err) {
      if (err instanceof BodyTooLarge) throw new VideoError('tooLarge', '', provider);
      if (opts.signal?.aborted) throw err;
      return fail(err instanceof Error ? err.message : String(err));
    }
    if (!isMp4(data)) throw new VideoError('notVideo', '', provider);
    return { data, provider, seconds };
  }
}
