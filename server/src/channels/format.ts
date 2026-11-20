/**
 * Turns a bot's Markdown reply into what a chat app shows: Telegram's HTML or WhatsApp's own
 * marks. Neither shows tables, so each table row becomes a short labelled list.
 */

import { maskSecretShapes } from '@yumakbot/shared';

/**
 * What stands in for a key or token in a message that leaves for a chat app. Only keys of a known
 * shape are taken out, not every `password: …` a reply writes: a channel is read by more people
 * than the conversation was, and a bot may repeat a key someone pasted to it.
 */
export const SECRET_MARK = '••••••';

type Block =
  | { kind: 'code'; lang: string; body: string }
  | { kind: 'table'; rows: string[][] }
  | { kind: 'lines'; lines: string[] };

const FENCE = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());
}

export function blocks(md: string): Block[] {
  const out: Block[] = [];
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let text: string[] = [];
  const flush = () => {
    if (text.length) out.push({ kind: 'lines', lines: text });
    text = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = line.match(FENCE);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(fence[1]!)) body.push(lines[i++]!);
      out.push({ kind: 'code', lang: fence[2] ?? '', body: body.join('\n') });
      continue;
    }
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]!)) {
      flush();
      const rows = [cells(line)];
      i += 2;
      while (i < lines.length && TABLE_ROW.test(lines[i]!)) rows.push(cells(lines[i++]!));
      i--;
      out.push({ kind: 'table', rows });
      continue;
    }
    text.push(line);
  }
  flush();
  return out;
}

/** Plain-text size of a block, to cut long replies between blocks rather than inside them. */
function size(b: Block): number {
  if (b.kind === 'code') return b.body.length + 10;
  if (b.kind === 'table') return b.rows.reduce((n, r) => n + r.join('  ').length + 20, 0);
  return b.lines.reduce((n, l) => n + l.length + 1, 0);
}

/** Splits a block that is too long on its own into pieces of at most `max` characters. */
function pieces(b: Block, max: number): Block[] {
  if (size(b) <= max) return [b];
  if (b.kind === 'table') {
    const [head, ...rows] = b.rows;
    const out: Block[] = [];
    let cur: string[][] = [];
    let n = 0;
    for (const r of rows) {
      const len = r.join('  ').length + 20;
      if (cur.length && n + len > max) {
        out.push({ kind: 'table', rows: [head!, ...cur] });
        cur = [];
        n = 0;
      }
      cur.push(r);
      n += len;
    }
    if (cur.length) out.push({ kind: 'table', rows: [head!, ...cur] });
    return out;
  }
  const lines = b.kind === 'code' ? b.body.split('\n') : b.lines;
  const groups: string[][] = [];
  let cur: string[] = [];
  let n = 0;
  for (let line of lines) {
    while (line.length > max) {
      if (cur.length) groups.push(cur);
      groups.push([line.slice(0, max)]);
      cur = [];
      n = 0;
      line = line.slice(max);
    }
    if (cur.length && n + line.length + 1 > max) {
      groups.push(cur);
      cur = [];
      n = 0;
    }
    cur.push(line);
    n += line.length + 1;
  }
  if (cur.length) groups.push(cur);
  return groups.map((g) =>
    b.kind === 'code' ? { kind: 'code', lang: b.lang, body: g.join('\n') } : { kind: 'lines', lines: g },
  );
}

/** The reply in parts of about `max` characters each, cut between paragraphs where possible. */
export function chunks(md: string, max: number): Block[][] {
  const out: Block[][] = [];
  let cur: Block[] = [];
  let n = 0;
  for (const b of blocks(maskSecretShapes(md, SECRET_MARK)).flatMap((b) => pieces(b, max))) {
    const len = size(b);
    if (cur.length && n + len > max) {
      out.push(cur);
      cur = [];
      n = 0;
    }
    cur.push(b);
    n += len;
  }
  if (cur.length) out.push(cur);
  return out;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

type Kind = 'bold' | 'italic' | 'strike';
const KIND: Record<string, Kind> = { '**': 'bold', __: 'bold', '*': 'italic', _: 'italic', '~~': 'strike' };
/** A letter, digit or `@`: a `_` touching one is part of a word or an address, not a mark. */
const WORDY = /[\p{L}\p{N}@]/u;

interface Span {
  mark: string;
  open: [number, number];
  close: [number, number];
}
interface Node {
  kind: Kind | null;
  kids: (string | Node)[];
}

/** The marked spans of a line: pairs of `**`, `__`, `*`, `_`, `~~` that open and close in the text. */
function spansOf(s: string): Span[] {
  const stack: { mark: string; at: number; len: number }[] = [];
  const spans: Span[] = [];
  for (let i = 0; i < s.length;) {
    const c = s[i]!;
    if (c !== '*' && c !== '_' && c !== '~') {
      i++;
      continue;
    }
    let j = i;
    while (s[j] === c) j++;
    const run = j - i;
    const prev = s[i - 1] ?? '';
    const next = s[j] ?? '';
    const spaceBefore = !prev || /\s/.test(prev);
    const spaceAfter = !next || /\s/.test(next);
    // A lone `*` or `_` inside a word is text (2*3*4, snake_case); `_` also keeps to that for
    // `__`, so a name with a double underscore in an address stays as written.
    const tight = c === '_' || run === 1;
    let canOpen = !spaceAfter && (!tight || !WORDY.test(prev));
    let canClose = !spaceBefore && (!tight || !WORDY.test(next));
    if (c === '~' && run !== 2) canOpen = canClose = false;
    const closes = canClose && (!canOpen || stack.some((e) => e.mark[0] === c));
    // A run of three is bold and italic together: opened outer-first, closed inner-first.
    const sizes: number[] = [];
    if (c === '~') sizes.push(2);
    else for (let n = run; n > 0; n -= 2) sizes.push(Math.min(n, 2));
    if (closes) sizes.reverse();
    let at = i;
    for (const len of sizes) {
      const mark = c.repeat(len);
      const idx = closes ? stack.map((e) => e.mark).lastIndexOf(mark) : -1;
      if (idx >= 0 && at > stack[idx]!.at + stack[idx]!.len) {
        const [o] = stack.splice(idx, 1);
        spans.push({ mark, open: [o!.at, o!.at + o!.len], close: [at, at + len] });
      } else if (canOpen) {
        stack.push({ mark, at, len });
      }
      at += len;
    }
    i = j;
  }
  return spans;
}

/**
 * The marks of a line, written by the chat app's own. Spans that cross (`**a _b** c_`) are closed
 * and opened again at the crossing, so what comes out is always properly nested and keeps both
 * styles.
 */
function emphasis(
  s: string,
  m: { bold: (s: string) => string; italic: (s: string) => string; strike: (s: string) => string },
): string {
  const spans = spansOf(s);
  if (!spans.length) return s;
  const events = spans
    .flatMap((span) => [
      { span, open: true, at: span.open[0], end: span.open[1] },
      { span, open: false, at: span.close[0], end: span.close[1] },
    ])
    .sort((a, b) => a.at - b.at);
  const root: Node = { kind: null, kids: [] };
  const stack: { node: Node; span: Span | null }[] = [{ node: root, span: null }];
  const top = () => stack[stack.length - 1]!.node;
  let pos = 0;
  for (const ev of events) {
    if (ev.at > pos) top().kids.push(s.slice(pos, ev.at));
    pos = ev.end;
    if (ev.open) {
      const node: Node = { kind: KIND[ev.span.mark]!, kids: [] };
      top().kids.push(node);
      stack.push({ node, span: ev.span });
      continue;
    }
    const [, ...crossed] = stack.splice(stack.findIndex((e) => e.span === ev.span));
    for (const c of crossed) {
      const node: Node = { kind: c.node.kind, kids: [] };
      top().kids.push(node);
      stack.push({ node, span: c.span });
    }
  }
  if (pos < s.length) root.kids.push(s.slice(pos));
  // Spaces stay outside a mark, which no chat app reads when it starts or ends with one.
  const draw = (n: Node): string => {
    const inner = n.kids.map((k) => (typeof k === 'string' ? k : draw(k))).join('');
    if (!n.kind) return inner;
    const core = inner.trim();
    if (!core) return inner;
    const at = inner.indexOf(core);
    return inner.slice(0, at) + m[n.kind](core) + inner.slice(at + core.length);
  };
  return draw(root);
}

/**
 * Inline marks of one line. Code spans and links are set aside first, so a `*` inside them is
 * never read as emphasis.
 */
function inline(
  s: string,
  m: {
    text: (s: string) => string;
    code: (s: string) => string;
    link: (label: string, url: string) => string;
    bold: (s: string) => string;
    italic: (s: string) => string;
    strike: (s: string) => string;
  },
): string {
  const kept: string[] = [];
  const keep = (v: string) => `\u0000${kept.push(v) - 1}\u0000`;
  // The markers are NUL-delimited; text that carried its own NUL could pass for one, so NUL goes
  // first (it means nothing in a chat message).
  let out = s
    // eslint-disable-next-line no-control-regex
    .replace(/\u0000/g, '')
    .replace(/`([^`\n]+)`/g, (_, c: string) => keep(m.code(c)))
    .replace(/!?\[([^\]\n]+)\]\((\S+?)\)/g, (_, label: string, url: string) => keep(m.link(label, url)))
    .replace(/(?<![\w/])(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g, (u: string) => keep(m.text(u)));
  out = m.text(out);
  out = emphasis(out, m);
  // A mark can hold others set aside before it (a code span in bold text). A piece only ever holds
  // pieces kept before it, so each is filled from lower numbers only and once: whatever the text,
  // this ends.
  // eslint-disable-next-line no-control-regex
  const hole = /\u0000(\d+)\u0000/g;
  const filled: (string | undefined)[] = [];
  const fill = (text: string, below: number): string =>
    text.replace(hole, (marker: string, n: string) => {
      const i = Number(n);
      if (!(i < below)) return marker;
      return (filled[i] ??= fill(kept[i]!, i));
    });
  return fill(out, kept.length);
}

interface Marks {
  inline: (s: string) => string;
  bold: (s: string) => string;
  code: (lang: string, body: string) => string;
  quote: (lines: string[]) => string;
}

function render(parts: Block[], k: Marks): string {
  const out: string[] = [];
  for (const b of parts) {
    if (b.kind === 'code') {
      out.push(k.code(b.lang, b.body));
      continue;
    }
    if (b.kind === 'table') {
      const [head = [], ...rows] = b.rows;
      const lines: string[] = [];
      for (const r of rows) {
        r.forEach((c, i) => {
          if (!c) return;
          if (i === 0) lines.push(k.bold(k.inline(c)));
          else lines.push(head[i] ? `${k.inline(head[i]!)}: ${k.inline(c)}` : k.inline(c));
        });
        lines.push('');
      }
      out.push(lines.join('\n').trimEnd());
      continue;
    }
    const lines: string[] = [];
    let quote: string[] = [];
    const endQuote = () => {
      if (quote.length) lines.push(k.quote(quote));
      quote = [];
    };
    for (const line of b.lines) {
      const q = line.match(/^\s*>\s?(.*)$/);
      if (q) {
        quote.push(k.inline(q[1]!));
        continue;
      }
      endQuote();
      const h = line.match(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/);
      if (h) lines.push(k.bold(k.inline(h[1]!)));
      else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) lines.push('———');
      else {
        const li = line.match(/^(\s*)[-*+]\s+(.*)$/);
        lines.push(li ? `${li[1]}• ${k.inline(li[2]!)}` : k.inline(line));
      }
    }
    endQuote();
    out.push(lines.join('\n'));
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const HTML: Marks = {
  inline: (s) =>
    inline(s, {
      text: esc,
      code: (c) => `<code>${esc(c)}</code>`,
      link: (label, url) => `<a href="${esc(url).replace(/"/g, '&quot;')}">${esc(label)}</a>`,
      bold: (x) => `<b>${x}</b>`,
      italic: (x) => `<i>${x}</i>`,
      strike: (x) => `<s>${x}</s>`,
    }),
  bold: (s) => `<b>${s}</b>`,
  code: (lang, body) =>
    lang ? `<pre><code class="language-${esc(lang)}">${esc(body)}</code></pre>` : `<pre>${esc(body)}</pre>`,
  quote: (lines) => `<blockquote>${lines.join('\n')}</blockquote>`,
};

/** WhatsApp marks pairs of `*`, `_`, `~`; a literal pair of them would turn into formatting. */
const WHATSAPP: Marks = {
  inline: (s) =>
    inline(s, {
      text: (x) => x,
      code: (c) => `\`${c}\``,
      link: (label, url) => (label === url ? url : `${label} (${url})`),
      bold: (x) => `*${x}*`,
      italic: (x) => `_${x}_`,
      strike: (x) => `~${x}~`,
    }),
  bold: (s) => `*${s}*`,
  code: (_lang, body) => `\`\`\`${body}\`\`\``,
  quote: (lines) => lines.map((l) => `> ${l}`).join('\n'),
};

/** Telegram HTML messages for a reply, each under Telegram's 4096-character limit. */
export function telegramMessages(md: string): { html: string; plain: string }[] {
  return chunks(md, 3000)
    .map((parts) => ({ html: render(parts, HTML), plain: plainText(parts) }))
    .filter((m) => m.plain.trim());
}

/** WhatsApp messages for a reply. */
export function whatsappMessages(md: string): string[] {
  return chunks(md, 4000)
    .map((parts) => render(parts, WHATSAPP))
    .filter((m) => m.trim());
}

/** The text as written, for when the chat app refuses the formatted one. */
function plainText(parts: Block[]): string {
  return parts
    .map((b) =>
      b.kind === 'code'
        ? b.body
        : b.kind === 'table'
          ? b.rows.map((r) => r.join(' | ')).join('\n')
          : b.lines.join('\n'),
    )
    .join('\n')
    .trim();
}

/**
 * Slack's mrkdwn. Its `& < >` are escaped everywhere, so text never becomes a mention such as
 * `<!channel>` or `<@U123>`, nor a link the bot did not write as one.
 */
const SLACK: Marks = {
  inline: (s) =>
    inline(s, {
      text: esc,
      code: (c) => `\`${esc(c)}\``,
      link: (label, url) =>
        /^https?:\/\/[^\s|<>]+$/.test(url) ? `<${esc(url)}|${esc(label).replace(/\|/g, '¦')}>` : esc(label),
      bold: (x) => `*${x}*`,
      italic: (x) => `_${x}_`,
      strike: (x) => `~${x}~`,
    }),
  bold: (s) => `*${s}*`,
  code: (_lang, body) => `\`\`\`${esc(body)}\`\`\``,
  quote: (lines) => lines.map((l) => `> ${l}`).join('\n'),
};

/** Slack messages for a reply, each well under Slack's limit for one message's text. */
export function slackMessages(md: string): string[] {
  return chunks(md, 3900)
    .map((parts) => render(parts, SLACK))
    .filter((m) => m.trim());
}

/** Text written into Slack as it is, with nothing in it read as a mention or a link. */
export const slackPlain = (s: string) => esc(maskSecretShapes(s, SECRET_MARK));

/**
 * Discord's own Markdown, without tables, which it does not show. Who a post may notify is set
 * on the post itself (only the people it names), so the text needs no escaping for that.
 */
const DISCORD: Marks = {
  inline: (s) =>
    inline(s, {
      text: (x) => x,
      code: (c) => `\`${c}\``,
      link: (label, url) => (/^https?:\/\/\S+$/.test(url) && label !== url ? `[${label}](<${url}>)` : url),
      bold: (x) => `**${x}**`,
      italic: (x) => `*${x}*`,
      strike: (x) => `~~${x}~~`,
    }),
  bold: (s) => `**${s}**`,
  code: (lang, body) => `\`\`\`${lang}\n${body}\n\`\`\``,
  quote: (lines) => lines.map((l) => `> ${l}`).join('\n'),
};

/** Discord posts for a reply, each under its 2,000-character limit with room for the marks. */
export function discordMessages(md: string): string[] {
  return chunks(md, 1800)
    .map((parts) => render(parts, DISCORD))
    .filter((m) => m.trim())
    .flatMap((m) => (m.length > 2000 ? (m.match(/[\s\S]{1,2000}/g) ?? []) : [m]));
}
