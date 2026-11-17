import { BodyTooLarge, readCapped } from './read-capped';
import { redactSecrets } from './secrets';
import type { ProviderKeyService } from './keys';

/** The shape the bot asks for; each provider gets it in its own terms. */
export type ImageShape = 'square' | 'landscape' | 'portrait';

/**
 * Providers that turn a prompt into a picture, through a key the person already saved. Both take
 * the same request at `/v1/images/generations` and answer with the image in base64.
 */
const SERVICES = [
  {
    provider: 'openai',
    url: 'https://api.openai.com/v1/images/generations',
    model: 'gpt-image-2',
    shape: (s: ImageShape) => ({
      size: { square: '1024x1024', landscape: '1536x1024', portrait: '1024x1536' }[s],
    }),
  },
  {
    provider: 'xai',
    url: 'https://api.x.ai/v1/images/generations',
    model: 'grok-imagine-image-2.0',
    shape: (s: ImageShape) => ({
      aspect_ratio: { square: '1:1', landscape: '3:2', portrait: '2:3' }[s],
      response_format: 'b64_json',
    }),
  },
] as const;

export const IMAGE_PROVIDERS: readonly string[] = SERVICES.map((s) => s.provider);

/** Large enough for a 4K picture; anything bigger is not what was asked for. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** Making a picture takes a while; one that takes longer than this has failed. */
const TIMEOUT_MS = 180_000;

/** The picture's format, read from its first bytes rather than from what the provider says. */
export function imageType(data: Buffer): 'png' | 'jpg' | 'webp' | 'gif' | null {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg';
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP')
    return 'webp';
  if (data.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  return null;
}

/** Why a picture could not be made, in words the bot passes on. */
export class ImageError extends Error {
  constructor(
    readonly reason: 'noKey' | 'failed' | 'notImage' | 'tooLarge',
    message = '',
    readonly provider = '',
  ) {
    super(message);
  }
}

export interface CreatedImage {
  data: Buffer;
  ext: 'png' | 'jpg' | 'webp' | 'gif';
  provider: string;
}

export class ImageService {
  constructor(
    private keys: ProviderKeyService,
    private fetcher: typeof fetch = fetch,
  ) {}

  /**
   * The provider to use: the one the bot already talks to when it can make pictures, so the person
   * pays one account; otherwise the first with a saved key. Only a saved key counts: a plan's
   * sign-in does not open these endpoints.
   */
  private async service(prefer?: string) {
    const order = [...SERVICES].sort((a, b) => Number(b.provider === prefer) - Number(a.provider === prefer));
    for (const s of order) {
      const key = await this.keys.get(s.provider);
      if (key) return { ...s, key };
    }
    return null;
  }

  async available(): Promise<boolean> {
    return !!(await this.service());
  }

  async create(
    prompt: string,
    opts: { shape?: ImageShape; prefer?: string; signal?: AbortSignal } = {},
  ): Promise<CreatedImage> {
    const s = await this.service(opts.prefer);
    if (!s) throw new ImageError('noKey');
    const signal = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(opts.signal ? [opts.signal] : [])]);
    const fail = (message: string): never => {
      // A provider may echo the request back; the key must not reach the bot or the chat.
      throw new ImageError('failed', redactSecrets(message.replaceAll(s.key, '***'), '***').text, s.provider);
    };
    let res: Response;
    try {
      res = await this.fetcher(s.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${s.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: s.model, prompt, n: 1, ...s.shape(opts.shape ?? 'square') }),
        signal,
      });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      return fail(err instanceof Error ? err.message : String(err));
    }
    const body = (await res.json().catch(() => null)) as {
      data?: { b64_json?: unknown; url?: unknown }[];
      error?: { message?: unknown } | string;
    } | null;
    const first = body?.data?.[0];
    if (!res.ok || !first) {
      const e = body?.error;
      return fail(String((typeof e === 'string' ? e : e?.message) ?? `HTTP ${res.status}`));
    }
    let data: Buffer;
    if (typeof first.b64_json === 'string' && first.b64_json) {
      data = Buffer.from(first.b64_json, 'base64');
    } else if (typeof first.url === 'string' && first.url.startsWith('https://')) {
      // Some answers give an address to fetch the picture from instead of the picture itself.
      const img = await this.fetcher(first.url, { signal }).catch((err: unknown) =>
        fail(err instanceof Error ? err.message : String(err)),
      );
      if (!img.ok) return fail(`HTTP ${img.status}`);
      if (Number(img.headers.get('content-length') ?? 0) > MAX_IMAGE_BYTES) {
        throw new ImageError('tooLarge', '', s.provider);
      }
      // Counted as it arrives: without a size header the whole body would otherwise be held first.
      try {
        data = await readCapped(img.body, MAX_IMAGE_BYTES);
      } catch (err) {
        if (err instanceof BodyTooLarge) throw new ImageError('tooLarge', '', s.provider);
        if (opts.signal?.aborted) throw err;
        return fail(err instanceof Error ? err.message : String(err));
      }
    } else {
      throw new ImageError('notImage', '', s.provider);
    }
    if (data.length > MAX_IMAGE_BYTES) throw new ImageError('tooLarge', '', s.provider);
    const ext = imageType(data);
    if (!ext) throw new ImageError('notImage', '', s.provider);
    return { data, ext, provider: s.provider };
  }
}
