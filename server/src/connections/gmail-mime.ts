/**
 * Building and reading mail for the Gmail tools this server runs itself: pure functions, no
 * network. Header values reach here already checked to hold no line break.
 */

export interface MailFile {
  /** Left out when the bot gave none; the file then reaches the recipient unnamed. */
  filename?: string;
  mimeType: string;
  data: Buffer;
  /** Shown inside the HTML body by `cid:`, not listed as a file. */
  contentId?: string;
}

export interface Mail {
  /** The account's own address to send from, for a draft written from one of its aliases. */
  from?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  text?: string;
  html?: string;
  files?: MailFile[];
  /** The Message-ID this mail answers, and the chain before it, so mail apps thread it. */
  inReplyTo?: string;
  references?: string;
}

/** A header's text: kept as is when plain ASCII, else encoded the way mail headers carry UTF-8. */
export function headerText(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

/** Base64 in lines of 76, as a mail body carries it. */
function base64Lines(data: Buffer): string {
  return (
    data
      .toString('base64')
      .match(/.{1,76}/g)
      ?.join('\r\n') ?? ''
  );
}

/** A file name as a header parameter: RFC 2231 for anything past plain ASCII. */
function fileParam(name: string, filename: string): string {
  if (/^[\x20-\x7e]*$/.test(filename) && !/["\\]/.test(filename)) return `${name}="${filename}"`;
  // encodeURIComponent leaves ' ( ) * ! as they are; a header parameter must not carry them bare.
  const encoded = encodeURIComponent(filename).replace(
    /['()*!]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${name}*=UTF-8''${encoded}`;
}

function textPart(type: string, text: string): string {
  return [
    `Content-Type: ${type}; charset="UTF-8"`,
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(Buffer.from(text, 'utf8')),
  ].join('\r\n');
}

/** A media type as a header may carry it: `type/subtype` alone, anything else the generic one. */
export function mediaType(s: string | undefined): string {
  return s && /^[\w.+-]+\/[\w.+-]+$/.test(s) ? s.toLowerCase() : 'application/octet-stream';
}

function filePart(f: MailFile): string {
  const named = (param: string) => (f.filename ? `; ${fileParam(param, f.filename)}` : '');
  return [
    `Content-Type: ${mediaType(f.mimeType)}${named('name')}`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: ${f.contentId ? 'inline' : 'attachment'}${named('filename')}`,
    ...(f.contentId ? [`Content-ID: <${f.contentId}>`] : []),
    '',
    base64Lines(f.data),
  ].join('\r\n');
}

/** Several parts under one multipart type. */
function multipart(type: string, boundary: string, parts: string[]): string {
  return [
    `Content-Type: multipart/${type}; boundary="${boundary}"`,
    '',
    ...parts.flatMap((p) => [`--${boundary}`, p]),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

/**
 * The mail as an RFC 5322 message: text and HTML as alternatives, pictures shown in the HTML
 * beside it, files after. Gmail fills in From with the account's own address.
 */
export function mimeMessage(m: Mail, boundary: string): string {
  const headers = [
    ...(m.from ? [`From: ${m.from}`] : []),
    ...(m.to.length ? [`To: ${m.to.join(', ')}`] : []),
    ...(m.cc?.length ? [`Cc: ${m.cc.join(', ')}`] : []),
    ...(m.bcc?.length ? [`Bcc: ${m.bcc.join(', ')}`] : []),
    ...(m.subject ? [`Subject: ${headerText(m.subject)}`] : []),
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`] : []),
    ...(m.references ? [`References: ${m.references}`] : []),
    'MIME-Version: 1.0',
  ];
  let body =
    m.html === undefined
      ? textPart('text/plain', m.text ?? '')
      : m.text === undefined
        ? textPart('text/html', m.html)
        : multipart('alternative', `${boundary}-a`, [
            textPart('text/plain', m.text),
            textPart('text/html', m.html),
          ]);
  const files = m.files ?? [];
  const inline = files.filter((f) => f.contentId);
  const attached = files.filter((f) => !f.contentId);
  if (inline.length) body = multipart('related', `${boundary}-r`, [body, ...inline.map(filePart)]);
  if (attached.length) body = multipart('mixed', `${boundary}-m`, [body, ...attached.map(filePart)]);
  return [...headers, body].join('\r\n');
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);

/** Plain text as HTML, line breaks kept. */
export const htmlFromText = (text: string) => escapeHtml(text).replace(/\r?\n/g, '<br>');

/** HTML as plain text, roughly: enough for a signature or a quoted mail's plain alternative. */
export function textFromHtml(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h\d)\b[^>]*>/gi, '\n')
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The body with the account's signature (HTML, as Gmail keeps it) at the end. */
export function withSignature(
  body: { text?: string; html?: string },
  signature: string,
): { text?: string; html?: string } {
  if (!signature.trim()) return body;
  const html = body.html ?? (body.text !== undefined ? htmlFromText(body.text) : '');
  const text = body.text ?? (body.html !== undefined ? textFromHtml(body.html) : '');
  return {
    text: `${text}\n\n-- \n${textFromHtml(signature)}`,
    html: `${html}<br><br><div class="gmail_signature">${signature}</div>`,
  };
}

const prefixed = (prefix: string, subject: string) =>
  new RegExp(`^${prefix}:`, 'i').test(subject.trim()) ? subject : `${prefix}: ${subject}`;
export const replySubject = (subject: string) => prefixed('Re', subject);
export const forwardSubject = (subject: string) => prefixed('Fwd', subject);

/** The plain addresses in a header such as `Ayşe <a@example.com>, b@example.com`. */
export function addressesIn(header: string | undefined): string[] {
  if (!header) return [];
  return [...header.matchAll(/[^\s<>,;"'()]+@[^\s<>,;"'()]+\.[^\s<>,;"'()]+/g)].map((m) => m[0]);
}

/**
 * The message ids (`<…@…>`) in a header such as References. Only the ids go on: the header came
 * from someone else's mail and could hold anything else.
 */
export function messageIds(header: string | undefined): string[] {
  return [...(header ?? '').matchAll(/<[^\s<>]+@[^\s<>]+>/g)].map((m) => m[0]);
}

/** A part of a message as the Gmail API returns it (`format=full`). */
export interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPart[];
}

export const headerOf = (part: GmailPart | undefined, name: string) =>
  part?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;

export interface ReadMail {
  text?: string;
  html?: string;
  files: {
    filename?: string;
    mimeType: string;
    /** Bytes as Gmail counts them, before fetching the file. */
    size: number;
    attachmentId?: string;
    data?: string;
    contentId?: string;
  }[];
}

/** A message's body and files, from the parts the Gmail API returns. */
export function readParts(payload: GmailPart | undefined): ReadMail {
  const out: ReadMail = { files: [] };
  const walk = (p: GmailPart | undefined) => {
    if (!p) return;
    const type = (p.mimeType ?? '').toLowerCase();
    // The id goes back into a header: kept only when it is a plain token.
    const cid = headerOf(p, 'Content-ID')
      ?.trim()
      .replace(/^<|>$/g, '')
      .match(/^[^\s<>"]+$/)?.[0];
    // A file has a name, or is kept apart from the body, or is a picture the HTML shows by its id.
    const file =
      !!p.filename ||
      (!type.startsWith('multipart/') && !type.startsWith('text/') && (!!p.body?.attachmentId || !!cid));
    if (file) {
      out.files.push({
        ...(p.filename && { filename: p.filename.replace(/[\r\n\0]/g, ' ') }),
        mimeType: mediaType(p.mimeType),
        size: p.body?.size ?? 0,
        ...(p.body?.attachmentId && { attachmentId: p.body.attachmentId }),
        ...(p.body?.data && { data: p.body.data }),
        ...(cid && { contentId: cid }),
      });
      // What is inside a file (a forwarded mail's own files and text) stays inside it.
      return;
    }
    if (type === 'text/plain' && out.text === undefined && p.body?.data) {
      out.text = Buffer.from(p.body.data, 'base64url').toString('utf8');
    } else if (type === 'text/html' && out.html === undefined && p.body?.data) {
      out.html = Buffer.from(p.body.data, 'base64url').toString('utf8');
    }
    for (const c of p.parts ?? []) walk(c);
  };
  walk(payload);
  return out;
}

/** The lines Gmail puts above a forwarded mail. */
export function forwardHeader(original: GmailPart | undefined): { text: string; html: string } {
  const rows = (['From', 'Date', 'Subject', 'To', 'Cc'] as const)
    .map((name) => [name, headerOf(original, name)] as const)
    .filter((r): r is readonly [(typeof r)[0], string] => !!r[1]);
  return {
    text: ['---------- Forwarded message ---------', ...rows.map(([k, v]) => `${k}: ${v}`)].join('\n'),
    html: [
      '<div class="gmail_quote">---------- Forwarded message ---------<br>',
      ...rows.map(([k, v]) => `${k}: ${escapeHtml(v)}<br>`),
      '</div>',
    ].join(''),
  };
}
