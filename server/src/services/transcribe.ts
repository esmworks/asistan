import type { Locale } from '@yumakbot/shared';
import { HttpError } from '../util';
import type { ProviderKeyService } from './keys';

/**
 * Speech to text for the message box, through a provider whose key the person already saved:
 * OpenAI first, then Groq. The recording goes from the server to that provider and nowhere else;
 * nothing is kept.
 */
const SERVICES = [
  {
    provider: 'openai',
    url: 'https://api.openai.com/v1/audio/transcriptions',
    model: 'gpt-4o-mini-transcribe',
  },
  {
    provider: 'groq',
    url: 'https://api.groq.com/openai/v1/audio/transcriptions',
    model: 'whisper-large-v3-turbo',
  },
] as const;
/** The providers take at most 25 MB; a minute of speech is well under 1 MB. */
export const MAX_AUDIO_BYTES = 24 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

/** A file name the provider reads the format from. */
function fileName(type: string): string {
  const sub = type.split(';')[0]!.split('/')[1] ?? 'webm';
  const ext =
    sub === 'mpeg' ? 'mp3' : sub === 'x-m4a' || sub === 'mp4' ? 'm4a' : sub.replace(/[^a-z0-9]/g, '');
  return `speech.${ext || 'webm'}`;
}

export class TranscribeService {
  constructor(
    private keys: ProviderKeyService,
    private fetcher: typeof fetch = fetch,
  ) {}

  private async service() {
    for (const s of SERVICES) {
      const key = await this.keys.get(s.provider);
      if (key) return { ...s, key };
    }
    return null;
  }

  /** Whether the server can turn speech into text: some provider for it has a key. */
  async available(): Promise<boolean> {
    return !!(await this.service());
  }

  async transcribe(audio: Buffer, type: string, locale?: Locale): Promise<string> {
    const s = await this.service();
    if (!s) throw new HttpError(409, 'error.transcribeNone');
    if (!audio.length) throw new HttpError(400, 'error.transcribeEmpty');
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type }), fileName(type));
    form.append('model', s.model);
    if (locale) form.append('language', locale);
    const res = await this.fetcher(s.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${s.key}` },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => null)) as {
      text?: unknown;
      error?: { message?: string };
    } | null;
    if (!res.ok || typeof body?.text !== 'string') {
      throw new HttpError(502, 'error.transcribeFailed', {
        message: body?.error?.message ?? String(res.status),
      });
    }
    return body.text.trim();
  }
}
