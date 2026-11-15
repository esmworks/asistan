/** How a file can be shown without downloading it, or null when it cannot. */
export type PreviewKind = 'image' | 'pdf' | 'audio' | 'video' | 'markdown' | 'table' | 'html' | 'text';

const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;
const MARKDOWN = /\.(md|markdown)$/i;
const AUDIO = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac)$/i;
const VIDEO = /\.(mp4|m4v|webm|mov)$/i;
/**
 * Plain text, shown as it is. An HTML page is drawn in a closed frame (see {@link htmlPreviewDocument})
 * with its source a click away. An SVG shows as a picture, which the server serves without scripts.
 */
const TEXT =
  /\.(txt|text|log|csv|tsv|json|jsonl|ya?ml|toml|ini|conf|cfg|env|xml|html?|svg|css|scss|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh|bash|zsh|fish|ps1|sql|r|lua|pl|ics|vcf|eml|srt|tex|diff|patch)$/i;
const TEXT_NAMES = /^(dockerfile|makefile|readme|license|changelog)$/i;

export function previewKind(name: string): PreviewKind | null {
  if (IMAGE.test(name)) return 'image';
  if (/\.pdf$/i.test(name)) return 'pdf';
  if (AUDIO.test(name)) return 'audio';
  if (VIDEO.test(name)) return 'video';
  if (MARKDOWN.test(name)) return 'markdown';
  if (/\.(csv|tsv)$/i.test(name)) return 'table';
  if (/\.html?$/i.test(name)) return 'html';
  if (TEXT.test(name) || TEXT_NAMES.test(name)) return 'text';
  return null;
}

/** What an HTML page drawn in the preview may load: its own inline styles and data: pictures. */
export const HTML_PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";

/**
 * An HTML page for a frame with an empty sandbox: its scripts never run, nothing outside it loads,
 * its forms send nothing, and the app's origin stays out of its reach.
 */
export function htmlPreviewDocument(source: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">${source}`;
}

/** The most text a preview reads; past it the rest is cut, and the file can still be downloaded. */
export const TEXT_PREVIEW_BYTES = 1024 * 1024;

/**
 * Reads at most `max` bytes of a file as UTF-8 text and stops there, so a large log does not load
 * whole. `cut` says whether there was more.
 */
export async function readTextStart(
  url: string,
  max = TEXT_PREVIEW_BYTES,
  signal?: AbortSignal,
): Promise<{ text: string; cut: boolean }> {
  const res = await fetch(url, { credentials: 'same-origin', signal });
  if (!res.ok || !res.body) throw new Error(String(res.status));
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > max) {
      chunks.push(value.subarray(0, max - size));
      size = max;
      cut = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  // A cut can split a character in two; the decoder drops the broken end instead of failing.
  return { text: new TextDecoder('utf-8').decode(bytes), cut };
}
