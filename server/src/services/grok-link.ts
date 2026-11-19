import { grokTemplateId, grokTemplatePage, type GrokTemplateCard } from '@yumakbot/shared';
import { HttpError } from '../util';
import { fetchPublicText, type PublicFetchOptions } from './skill-link';

/** The share page is about 70 KB; anything far larger is not that page. */
const PAGE_MAX = 1024 * 1024;

/** A JSON string literal, quotes included. */
const STRING = String.raw`"(?:[^"\\]|\\.)*"`;

/**
 * The text the page streams to its scripts. The bot's details are inside it as data the page
 * fills in on load; each chunk is a JSON string literal, so parsing it undoes the escaping.
 */
function streamedText(html: string): string {
  const chunks: string[] = [];
  for (const m of html.matchAll(new RegExp(String.raw`self\.__next_f\.push\(\[1,(${STRING})\]\)`, 'g'))) {
    try {
      chunks.push(JSON.parse(m[1]!) as string);
    } catch {
      // A chunk that is not a string literal holds nothing we read.
    }
  }
  return chunks.join('');
}

/**
 * The JSON object that starts at `start` (an opening brace), parsed; null when it does not close
 * or is not JSON. Braces inside strings are skipped, so a description holding `}` does not end it.
 */
function objectAt(text: string, start: number): Record<string, unknown> | null {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        const value: unknown = JSON.parse(text.slice(start, i + 1));
        return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** A text field of the template, trimmed and cut to `max`; null when absent, empty or not text. */
function field(card: Record<string, unknown>, name: string, max: number): string | null {
  const value = card[name];
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim().slice(0, max).trimEnd();
}

/**
 * The card for template `id` from the share page's HTML: what the page itself shows. A page whose
 * layout changed gives empty fields rather than an error, since the card only names the bot.
 */
export function parseGrokTemplatePage(html: string, id: string): GrokTemplateCard {
  const empty: GrokTemplateCard = { id, name: null, sharer: null, description: null };
  const text = streamedText(html);
  // The template is the object whose first key is its id; only its own fields are read, so a
  // field it lacks is never taken from another object further on.
  const at = text.indexOf(`{"id":${JSON.stringify(id)}`);
  const card = at < 0 ? null : objectAt(text, at);
  if (!card) return empty;
  return {
    id,
    name: field(card, 'botName', 60),
    sharer: field(card, 'sharerName', 60),
    description: field(card, 'description', 500),
  };
}

/**
 * The card for a Grok Bot share link. Only the page built from the link's id is read, never the
 * address as pasted; when it cannot be reached, the card carries the link alone.
 */
export async function readGrokLink(
  input: string,
  o: Pick<PublicFetchOptions, 'resolve'> = {},
): Promise<GrokTemplateCard> {
  const id = grokTemplateId(input);
  if (!id) throw new HttpError(400, 'error.grokLinkInvalid');
  try {
    const html = await fetchPublicText(new URL(grokTemplatePage(id)), PAGE_MAX, {
      ...o,
      timeoutMs: 10_000,
      // The site answers a browser; a bare client may be turned away.
      userAgent: 'Mozilla/5.0',
      accept: 'text/html',
    });
    return parseGrokTemplatePage(html, id);
  } catch {
    return parseGrokTemplatePage('', id);
  }
}
