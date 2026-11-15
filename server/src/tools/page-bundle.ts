import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path';

/** Data a page fetches, carried with it under these types. */
const DATA_TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.geojson': 'application/geo+json',
  '.topojson': 'application/json',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.ndjson': 'application/x-ndjson',
  '.txt': 'text/plain',
};
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};
const MAX_TOTAL = 4 * 1024 * 1024;
const MAX_FILES = 100;

/** A page made whole: its own scripts, styles, pictures and data inside it, and what could not be. */
export interface PageBundle {
  html: string;
  /** Files beside the page it does not carry, each with why (shown to the bot). */
  leftOut: { name: string; why: 'type' | 'hidden' | 'size' | 'outside' }[];
}

const inside = (p: string, root: string) => {
  const r = relative(root, p);
  return r !== '' && !r.startsWith('..') && !isAbsolute(r);
};

/** The files under the page's folder, two levels deep, by their path from it. */
async function folderFiles(root: string, left: PageBundle['leftOut']): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string, depth: number) => {
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const full = join(dir, name);
      const rel = relative(root, full).split(sep).join('/');
      if (name.startsWith('.')) {
        left.push({ name: rel, why: 'hidden' });
        continue;
      }
      const info = await lstat(full).catch(() => null);
      if (!info) continue;
      if (info.isSymbolicLink()) {
        // A link that leads out of the folder is not followed.
        const real = await realpath(full).catch(() => null);
        if (!real || !inside(real, root)) {
          left.push({ name: rel, why: 'outside' });
          continue;
        }
      }
      if (info.isDirectory()) {
        if (depth < 2) await walk(full, depth + 1);
        continue;
      }
      if (out.size < MAX_FILES) out.set(rel, full);
    }
  };
  await walk(root, 0);
  return out;
}

/** A value safe inside a <script> element. */
const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

/**
 * Makes a bot's page whole, so it runs in the sandboxed frame that loads nothing from this server:
 * its own scripts and styles inlined, small pictures as data URIs, and data files it fetches
 * (.json, .geojson, .csv…) answered from inside the page.
 */
export async function bundlePage(file: string): Promise<PageBundle> {
  const root = await realpath(dirname(file));
  const leftOut: PageBundle['leftOut'] = [];
  const files = await folderFiles(root, leftOut);
  let html = await readFile(file, 'utf8');
  let total = Buffer.byteLength(html);
  const used = new Set<string>([
    relative(root, await realpath(file))
      .split(sep)
      .join('/'),
  ]);
  const local = (ref: string) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(ref)) return null;
    const key = ref.replace(/^\.\//, '').split(/[?#]/)[0]!;
    return files.has(key) ? key : null;
  };
  const read = async (key: string, encoding: 'utf8' | 'base64') => {
    const text = await readFile(files.get(key)!, encoding);
    if (total + text.length > MAX_TOTAL) {
      leftOut.push({ name: key, why: 'size' });
      return null;
    }
    total += text.length;
    used.add(key);
    return text;
  };
  const replaceAsync = async (re: RegExp, fn: (m: RegExpMatchArray) => Promise<string | null>) => {
    const parts: string[] = [];
    let last = 0;
    for (const m of html.matchAll(re)) {
      parts.push(html.slice(last, m.index), (await fn(m)) ?? m[0]);
      last = m.index! + m[0].length;
    }
    html = parts.join('') + html.slice(last);
  };
  await replaceAsync(/<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi, async (m) => {
    const key = local(m[2]!);
    const code = key && /\.m?js$/i.test(key) ? await read(key, 'utf8') : null;
    return code === null
      ? null
      : `<script${m[1]}${m[3]}>${code.replace(/<\/script/gi, '<\\/script')}</script>`;
  });
  await replaceAsync(/<link\b[^>]*\brel=["']stylesheet["'][^>]*>/gi, async (m) => {
    const href = /\bhref=["']([^"']+)["']/i.exec(m[0])?.[1];
    const key = href ? local(href) : null;
    const css = key && /\.css$/i.test(key) ? await read(key, 'utf8') : null;
    return css === null ? null : `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`;
  });
  await replaceAsync(/\b(src|href)=["']([^"']+)["']/gi, async (m) => {
    const key = local(m[2]!);
    const type = key ? IMAGE_TYPES[extname(key).toLowerCase()] : undefined;
    const data = key && type ? await read(key, 'base64') : null;
    return data === null ? null : `${m[1]}="data:${type};base64,${data}"`;
  });
  // The data it may fetch, answered from inside the page.
  const carried: Record<string, { type: string; text: string }> = {};
  for (const key of files.keys()) {
    const type = DATA_TYPES[extname(key).toLowerCase()];
    if (!type || used.has(key)) continue;
    const text = await read(key, 'utf8');
    if (text !== null) carried[key] = { type, text };
  }
  for (const key of files.keys()) {
    if (!used.has(key) && !leftOut.some((l) => l.name === key)) leftOut.push({ name: key, why: 'type' });
  }
  if (Object.keys(carried).length) {
    const shim = `<script>(()=>{const F=${scriptJson(carried)};const k=(u)=>{u=typeof u==='string'?u:u&&u.url;if(typeof u!=='string')return null;try{const b=new URL('.',location.href).href;if(u.startsWith(b))u=u.slice(b.length)}catch(e){}if(/^(?:[a-z][a-z0-9+.-]*:|\\/\\/|\\/)/i.test(u))return null;u=u.replace(/^\\.\\//,'').split(/[?#]/)[0];return Object.prototype.hasOwnProperty.call(F,u)?u:null};const f=window.fetch.bind(window);window.fetch=(i,o)=>{const n=k(i);return n?Promise.resolve(new Response(F[n].text,{status:200,headers:{'content-type':F[n].type}})):f(i,o)}})()</script>`;
    html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (h) => h + shim) : shim + html;
  }
  return { html, leftOut };
}
