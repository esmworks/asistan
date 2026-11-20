/**
 * Text a page keeps out of a person's sight but leaves for a program to read, written to steer an
 * AI agent: "ignore your previous instructions", "AI assistants reading this must…". A person
 * reading the page never sees it, so the bot is the only one who would; it is told the text is
 * data, and the person is told it was there.
 *
 * Two readers find it: one runs in the bot's browser and looks at how the page is drawn, the other
 * reads raw HTML (a page fetched without a browser) and can only go by what the markup says.
 * Neither decides alone: hidden text is common (menus, screen-reader labels, templates), so only
 * hidden text that also speaks to an agent counts.
 */

/** Longest stretch of hidden text kept from one element, and how many are kept per page. */
const SNIPPET_MAX = 600;
const SNIPPETS_MAX = 40;
/** Elements looked at on one page at most, so a huge page does not hold a step up. */
const ELEMENTS_MAX = 20_000;

/**
 * Words that speak to an AI agent rather than to a person: naming it, or telling it to drop what
 * it was told. English and Turkish, as the person's pages are mostly one of the two.
 */
const ADDRESSED = [
  /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|your|any)\b[^.\n]{0,30}\b(?:instructions?|prompts?|rules?|directions?|guidelines?)\b/i,
  /\b(?:AI|LLM|GPT|Claude|Gemini|language model)\s+(?:agents?|assistants?|models?|bots?|crawlers?|systems?)\b[^.\n]{0,80}\b(?:must|should|need to|are (?:instructed|required)|will|shall)\b/i,
  /\b(?:if|when)\s+you\s+are\s+an?\s+(?:AI|LLM|language model|assistant|agent|bot)\b/i,
  /\b(?:system prompt|new instructions|developer message|hidden instructions?)\s*[:-]/i,
  /\byou\s+are\s+now\b[^.\n]{0,40}\b(?:assistant|agent|AI|mode)\b/i,
  /\bdo\s+not\s+(?:tell|inform|mention\s+(?:this\s+)?to)\s+the\s+(?:user|human|person)\b/i,
  /(?<!\p{L})(?:önceki|yukarıdaki|tüm|bütün)(?!\p{L})[^.\n]{0,30}(?<!\p{L})(?:talimatları|komutları|kuralları|yönergeleri)(?!\p{L})[^.\n]{0,30}(?:yok say|unut|görmezden gel|dikkate alma)/iu,
  /(?<!\p{L})(?:yapay zek[aâ]|YZ|dil modeli)(?!\p{L})[^.\n]{0,60}(?:yapmalı|zorunda|gerekir|talimat)/iu,
  /(?<!\p{L})kullanıcıya\s+(?:söyleme|bahsetme|haber verme)(?!\p{L})/iu,
];

/** Whether a stretch of text speaks to an AI agent the way a planted instruction does. */
export function addressedToAgents(text: string): boolean {
  const flat = text.replace(/\s+/g, ' ');
  return ADDRESSED.some((re) => re.test(flat));
}

/** The hidden stretches of a page that speak to an agent, cut short; empty when there are none. */
export function plantedIn(snippets: string[]): string[] {
  return snippets
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s && addressedToAgents(s))
    .slice(0, 3)
    .map((s) => (s.length > 200 ? `${s.slice(0, 199)}…` : s));
}

/**
 * Runs in the page (Playwright's `evaluate`): the text of elements a person cannot see there,
 * though they are in the page. Not shown at all, see-through, a few pixels tall, pushed far off
 * the page, clipped to nothing, or drawn in the colour of what is behind them. Comments in the
 * markup count too, as some readers pass them on.
 */
export const HIDDEN_TEXT_SCRIPT = `(() => {
  const out = [];
  const max = ${SNIPPETS_MAX};
  const cut = (s) => s.replace(/\\s+/g, ' ').trim().slice(0, ${SNIPPET_MAX});
  const W = Math.max(document.documentElement.scrollWidth, innerWidth);
  const H = Math.max(document.documentElement.scrollHeight, innerHeight);
  const rgb = (c) => { const m = /rgba?\\(([^)]+)\\)/.exec(c || ''); if (!m) return null; const p = m[1].split(',').map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  // Each element's style and background are read once: the background is found by going up,
  // and what a parent found is kept for its children.
  const styles = new Map();
  const st = (el) => { let s = styles.get(el); if (!s) { s = getComputedStyle(el); styles.set(el, s); } return s; };
  const white = { r: 255, g: 255, b: 255, a: 1 };
  const bgs = new Map();
  const bg = (el) => {
    if (!el) return white;
    if (bgs.has(el)) return bgs.get(el);
    const c = rgb(st(el).backgroundColor);
    const v = c && c.a > 0.9 ? c : bg(el.parentElement);
    bgs.set(el, v);
    return v;
  };
  const same = (a, b) => a && b && Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) < 24;
  const hidden = (el) => {
    const s = st(el);
    if (el.hidden || s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse') return true;
    if (Number(s.opacity) < 0.05 || el.getAttribute('aria-hidden') === 'true') return true;
    if (parseFloat(s.fontSize) < 3) return true;
    if (/rect\\(\\s*0(px)?[ ,]+0(px)?[ ,]+0(px)?[ ,]+0(px)?\\s*\\)/.test(s.clip) || s.clipPath === 'inset(50%)' || s.clipPath === 'inset(100%)') return true;
    const r = el.getBoundingClientRect();
    if (r.width * r.height > 0 && (r.right + scrollX < -200 || r.bottom + scrollY < -200 || r.left + scrollX > W + 200 || r.top + scrollY > H + 200)) return true;
    return r.width * r.height > 0 && r.width < 2 && r.height < 2 && s.overflow === 'hidden';
  };
  // Text drawn in the colour behind it: looked at only where an element holds text of its own.
  const ownText = (el) => { for (const n of el.childNodes) if (n.nodeType === 3 && n.nodeValue.trim()) return true; return false; };
  const blended = (el) => { const c = rgb(st(el).color); return !!c && c.a > 0.5 && same(c, bg(el)); };
  // Each element is visited once and its text read only when it is hidden, which ends the walk
  // below it: the cost grows with the page, not with its depth times its size.
  let seen = 0;
  const walk = (el) => {
    if (out.length >= max || ++seen > ${ELEMENTS_MAX}) return;
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'svg'].includes(el.tagName)) return;
    if (hidden(el) || (ownText(el) && blended(el))) {
      const text = el.textContent || '';
      if (text.trim().length >= 12) out.push(cut(text));
      return;
    }
    for (const child of el.children) walk(child);
  };
  if (document.body) walk(document.body);
  const it = document.createNodeIterator(document.documentElement, NodeFilter.SHOW_COMMENT);
  for (let n = it.nextNode(); n && out.length < max; n = it.nextNode()) {
    const text = n.nodeValue || '';
    if (text.trim().length >= 12) out.push(cut(text));
  }
  return out;
})()`;

/** An element's opening tag that the markup itself hides; the browser's view is not at hand. */
const HIDING_TAG =
  /<([a-z][a-z0-9-]*)\b(?=[^>]*(?:\shidden(?:\s|=|>|\/)|aria-hidden\s*=\s*["']?true|style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0+)?\s*(?:;|["'])|font-size\s*:\s*0|left\s*:\s*-\d{3,}|text-indent\s*:\s*-\d{3,})))[^>]*>/gi;

/**
 * The hidden stretches of raw HTML, as far as the markup says: elements hidden by an attribute or
 * an inline style, and comments. A stylesheet that hides an element by its class is not seen here.
 */
export function hiddenInHtml(html: string): string[] {
  const out: string[] = [];
  const text = (s: string) =>
    s
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, SNIPPET_MAX);
  const lower = html.toLowerCase();
  for (const m of html.matchAll(HIDING_TAG)) {
    if (out.length >= SNIPPETS_MAX) break;
    const name = m[1]!.toLowerCase();
    if (name === 'script' || name === 'style' || name === 'template') continue;
    const start = m.index! + m[0].length;
    const end = lower.indexOf(`</${name}`, start);
    const inner = text(html.slice(start, end < 0 ? start + SNIPPET_MAX * 4 : end));
    if (inner.length >= 12) out.push(inner);
  }
  for (const m of html.matchAll(/<!--([\s\S]*?)-->/g)) {
    if (out.length >= SNIPPETS_MAX) break;
    const inner = m[1]!.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_MAX);
    if (inner.length >= 12) out.push(inner);
  }
  return out;
}
