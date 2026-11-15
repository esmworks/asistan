/**
 * Pages that run their own scripts inside the app: a page a bot made, or an MCP app's view. The
 * server serves them sandboxed (no allow-same-origin, so an opaque origin) under a strict policy
 * that decides what they may load; they talk to the app only through messages the app checks.
 */

/** Libraries a bot's page may load. */
export const PAGE_LIBRARIES = [
  'https://cdn.jsdelivr.net',
  'https://unpkg.com',
  'https://cdnjs.cloudflare.com',
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
];

/** An https origin (a `*.` wildcard allowed); anything else could break out of the policy. */
const ORIGIN = /^https:\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?$/i;

export function frameCsp(o: { resources?: string[]; connect?: string[]; images?: string[] }): string {
  const list = (v: string[] = []) => v.filter((x) => ORIGIN.test(x)).join(' ');
  const res = list(o.resources);
  const images = [...(o.images ?? []).filter((x) => x === 'https:'), res].filter(Boolean).join(' ');
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${res}`.trim(),
    `style-src 'unsafe-inline' ${res}`.trim(),
    `img-src data: blob: ${images}`.trim(),
    `font-src data: ${res}`.trim(),
    `media-src data: blob: ${res}`.trim(),
    `connect-src ${list(o.connect) || "'none'"}`,
    "frame-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

/**
 * Reports the page's height to the app, so the frame grows with it. The flow is measured with the
 * root and body freed to their content: a page laid out to the window (a map, a canvas, a layer at
 * inset 0, or html, body and #map at 100%) has almost none, and would shrink the frame to a strip.
 * Such a page reports `fallback` instead, until its flow needs more.
 */
function sizeReporter(fallback: number): string {
  return `<script>(()=>{const F=${fallback};const flow=()=>{const r=document.documentElement,b=document.body;if(!b)return r.scrollHeight;const a=[r.style.height,b.style.height,r.style.minHeight,b.style.minHeight];r.style.height=b.style.height='auto';r.style.minHeight=b.style.minHeight='0';const cs=getComputedStyle(b);const h=Math.ceil(b.getBoundingClientRect().height+(parseFloat(cs.marginTop)||0)+(parseFloat(cs.marginBottom)||0));[r.style.height,b.style.height,r.style.minHeight,b.style.minHeight]=a;return h};const layer=()=>{let e=document.elementFromPoint(innerWidth/2,innerHeight/2);while(e&&e!==document.body&&e!==document.documentElement){const q=e.getBoundingClientRect();if(q.width>=innerWidth/2&&q.height>=innerHeight/2)return true;e=e.parentElement}return false};const s=()=>{const f=flow();const h=f<120&&layer()?Math.max(F,f):f;parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/size-changed',params:{height:h}},'*')};addEventListener('load',()=>{s();new ResizeObserver(s).observe(document.documentElement)})})()</script>`;
}

/** The frame's whole policy as a response header: sandboxed, framed only by the app itself. */
export function frameHeader(csp: string): string {
  return `sandbox allow-scripts allow-forms; ${csp}; frame-ancestors 'self'`;
}

/** The frame's document: the policy first, then the page (its own doctype dropped for ours). */
export function frameDocument(
  html: string,
  csp: string,
  opts: { reportSize?: boolean; fallbackHeight?: number } = {},
): string {
  const body = html.replace(/^\s*<!doctype[^>]*>/i, '');
  const policy = csp.replace(/"/g, '&quot;');
  return `<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="${policy}">${opts.reportSize ? sizeReporter(opts.fallbackHeight ?? 520) : ''}${body}`;
}
