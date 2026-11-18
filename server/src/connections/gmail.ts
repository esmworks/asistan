import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { StoredConnectionTool } from '../db/schema';
import { fetchSignedIn, type ClientTarget } from './client';

/**
 * Sending mail for a Gmail connection whose MCP server lists no tool that sends. The sign-in
 * already holds the compose scope, which lets the Gmail API send; this server then adds a
 * `send_message` of its own and sends through that API. Once the server lists its own
 * `send_message`, the added tool goes and the server's is used.
 */
const GMAIL_MCP_HOST = 'gmailmcp.googleapis.com';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const NAME = 'send_message';

/** The most recipients and characters a mail may carry; more is surely a mistake. */
const MAX_RECIPIENTS = 100;
const MAX_BODY = 500_000;

const address = z
  .string()
  .trim()
  .max(320)
  // A plain address: no name part, no line break that would start another header.
  .regex(/^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/, 'a plain email address, e.g. user@example.com');

/** What the tool takes. Unknown keys are refused: the card shows every field that goes out. */
export const GmailSendInput = z
  .object({
    to: z.array(address).min(1).max(MAX_RECIPIENTS),
    cc: z.array(address).max(MAX_RECIPIENTS).optional(),
    bcc: z.array(address).max(MAX_RECIPIENTS).optional(),
    subject: z
      .string()
      .max(998)
      .refine((s) => !/[\r\n]/.test(s), 'one line, with no line break')
      .optional(),
    body: z.string().max(MAX_BODY).optional(),
    htmlBody: z.string().max(MAX_BODY).optional(),
  })
  .strict()
  .refine((m) => m.body !== undefined || m.htmlBody !== undefined, 'body or htmlBody is required');
export type GmailSendInput = z.infer<typeof GmailSendInput>;

const SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['to'],
  properties: {
    to: {
      type: 'array',
      items: { type: 'string' },
      description: 'Recipients, each a plain address (user@example.com).',
    },
    cc: { type: 'array', items: { type: 'string' }, description: 'Carbon copy recipients, plain addresses.' },
    bcc: {
      type: 'array',
      items: { type: 'string' },
      description: 'Blind carbon copy recipients, plain addresses.',
    },
    subject: { type: 'string', description: 'The subject line.' },
    body: {
      type: 'string',
      description: 'Plain text body. No Markdown. With htmlBody, it is the plain-text alternative.',
    },
    htmlBody: { type: 'string', description: 'HTML body, for formatted text.' },
  },
};

/** The tool as a connection stores it; the person's choices on it are kept across refreshes. */
function sendTool(kept?: StoredConnectionTool): StoredConnectionTool {
  return {
    name: NAME,
    title: 'Send email',
    description:
      "Sends a new email from the signed-in Gmail account right away. Give recipients in `to` (and `cc`, `bcc`), a `subject`, and the content in `body` (plain text) or `htmlBody` (HTML). Sent mail appears in Gmail's Sent folder. Returns the sent message's id and threadId.",
    inputSchema: SCHEMA,
    hinted: 'write',
    kind: null,
    enabled: kept?.enabled ?? true,
    local: 'gmailSend',
  };
}

export function isGmailMcp(url: string): boolean {
  try {
    return new URL(url).hostname === GMAIL_MCP_HOST;
  } catch {
    return false;
  }
}

/**
 * The tools of a connection after a refresh: for Gmail with no sending tool of its own, this
 * server's is added. `kept` is the list before the refresh, whose switch on the added tool stays.
 */
export function withGmailSend(
  url: string,
  listed: StoredConnectionTool[],
  kept: StoredConnectionTool[],
): StoredConnectionTool[] {
  if (!isGmailMcp(url) || listed.some((t) => t.name === NAME)) return listed;
  return [...listed, sendTool(kept.find((t) => t.name === NAME && t.local === 'gmailSend'))];
}

/** A header's text: kept as is when plain ASCII, else encoded the way mail headers carry UTF-8. */
function headerText(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

/** Base64 in lines of 76, as a mail body carries it. */
function base64Lines(s: string): string {
  return (
    Buffer.from(s, 'utf8')
      .toString('base64')
      .match(/.{1,76}/g)
      ?.join('\r\n') ?? ''
  );
}

function part(type: string, text: string): string {
  return [
    `Content-Type: ${type}; charset="UTF-8"`,
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(text),
  ].join('\r\n');
}

/**
 * The mail as an RFC 5322 message. Gmail fills in From with the account's own address. Header
 * values were checked to hold no line break, so nothing can add a header of its own.
 */
export function mimeMessage(m: GmailSendInput, boundary: string): string {
  const headers = [
    `To: ${m.to.join(', ')}`,
    ...(m.cc?.length ? [`Cc: ${m.cc.join(', ')}`] : []),
    ...(m.bcc?.length ? [`Bcc: ${m.bcc.join(', ')}`] : []),
    ...(m.subject ? [`Subject: ${headerText(m.subject)}`] : []),
    'MIME-Version: 1.0',
  ];
  if (m.htmlBody === undefined) return [...headers, part('text/plain', m.body ?? '')].join('\r\n');
  if (m.body === undefined) return [...headers, part('text/html', m.htmlBody)].join('\r\n');
  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    part('text/plain', m.body),
    `--${boundary}`,
    part('text/html', m.htmlBody),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

const fail = (text: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text }] });

/**
 * Sends the mail through the Gmail API. Anything Google refuses comes back with its status and
 * its own words, so the bot (and the person) can see why: the API not turned on in the Google
 * Cloud project, a scope missing from the sign-in, a bad address.
 */
export async function sendGmail(
  target: ClientTarget,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  const parsed = GmailSendInput.safeParse(args);
  if (!parsed.success) {
    return fail(
      `Not sent: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`,
    );
  }
  const raw = Buffer.from(mimeMessage(parsed.data, `yumak-${crypto.randomUUID()}`), 'utf8').toString(
    'base64url',
  );
  const res = await fetchSignedIn(target, SEND_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
    ...(signal ? { signal } : {}),
  });
  const text = await res.text();
  if (!res.ok) return fail(`Gmail did not send the mail (HTTP ${res.status}): ${text.slice(0, 2000)}`);
  let sent: { id?: string; threadId?: string } = {};
  try {
    sent = JSON.parse(text) as typeof sent;
  } catch {
    // The mail went; the answer is only for the bot to quote.
  }
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ sent: true, id: sent.id ?? null, threadId: sent.threadId ?? null }),
      },
    ],
  };
}
