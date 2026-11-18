import { imageType } from '../services/images';
import { fetchPublicBytes } from '../services/skill-link';

/**
 * A mail signature's pictures (a logo, a banner), brought into the signature itself as `data:`
 * addresses. The app's pages load pictures from this server alone, so the card that shows a mail
 * before it goes could not show them otherwise; the person's browser never reaches the address.
 */
const MAX_PICTURES = 12;
const MAX_PICTURE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

type Fetch = (url: URL) => Promise<Buffer>;

const fetchPicture: Fetch = (url) =>
  // Pictures kept on Google's servers often answer with a redirect first.
  fetchPublicBytes(url, MAX_PICTURE_BYTES, { redirects: 3, timeoutMs: 10_000 });

const IMG_SRC = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])(.*?)\2/gi;
const unescape = (s: string) => s.replace(/&amp;/g, '&');

/**
 * The signature with each picture it loads from the web put inside it. A picture that cannot be
 * fetched, is not a picture, or goes past the limits keeps its address, which the card's frame
 * does not load.
 */
export async function inlinePictures(html: string, fetch: Fetch = fetchPicture): Promise<string> {
  const urls = [...new Set([...html.matchAll(IMG_SRC)].map((m) => unescape(m[3]!.trim())))]
    .filter((u) => /^https?:\/\//i.test(u))
    .slice(0, MAX_PICTURES);
  const got = await Promise.all(
    urls.map(async (u) => {
      try {
        const url = new URL(u);
        // A plain http picture is asked for over https; most servers serve both.
        url.protocol = 'https:';
        const data = await fetch(url);
        const type = imageType(data);
        return type ? { u, data, type } : null;
      } catch {
        return null;
      }
    }),
  );
  const inline = new Map<string, string>();
  let total = 0;
  for (const g of got) {
    if (!g || total + g.data.length > MAX_TOTAL_BYTES) continue;
    total += g.data.length;
    inline.set(g.u, `data:image/${g.type === 'jpg' ? 'jpeg' : g.type};base64,${g.data.toString('base64')}`);
  }
  return html.replace(IMG_SRC, (all, head: string, quote: string, src: string) => {
    const data = inline.get(unescape(src.trim()));
    return data ? `${head}${quote}${data}${quote}` : all;
  });
}
