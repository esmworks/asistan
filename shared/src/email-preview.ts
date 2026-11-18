import { connectionToolParts } from './actions';

/** What a connected app's mail tool is asked to do: send a new mail, reply, forward or keep a draft. */
export type EmailKind = 'send' | 'reply' | 'forward' | 'draft';

/** A mail a bot asks to send through a connected app, as the person reads it before saying yes. */
export interface EmailPreview {
  kind: EmailKind;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string | null;
  /** The plain text, when the bot wrote one. */
  text: string | null;
  /** The formatted body, when the bot wrote one. */
  html: string | null;
  /** A reply goes to everyone on the mail it answers. */
  replyAll: boolean;
  /** The account's own signature is added when it goes. */
  signature: boolean;
  /** The names of the files it carries. */
  attachments: string[];
  /** An existing draft is sent as it is; the bot gave no content of its own. */
  draftId: string | null;
  /** A new mail or draft goes into an existing conversation, as a reply in it. */
  inThread: boolean;
  /** Everything the tool is given, with attachments' content left out, for the person who wants to see it all. */
  raw: string;
}

/** Who a connected mail account sends as: its default address and that address's signature (HTML). */
export interface MailSender {
  address: string | null;
  signature: string | null;
}

/** Tool names mail services use, by what they do. A tool is read as mail only when its input looks like one too. */
const KINDS: [RegExp, EmailKind][] = [
  [/^(send_message|send_email|send_mail|send_draft)$/, 'send'],
  [/^(reply|reply_all|reply_email|reply_to_(mail_)?message)$/, 'reply'],
  [/^(forward|forward_email|forward_(mail_)?message)$/, 'forward'],
  [/^(create_draft|update_draft)$/, 'draft'],
];

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** One address from the shapes services use: a plain string, `{email}`, `{address}` or `{emailAddress: {address}}`. */
function address(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const nested = o.emailAddress && typeof o.emailAddress === 'object' ? o.emailAddress : null;
  return str(o.email) ?? str(o.address) ?? (nested ? str((nested as Record<string, unknown>).address) : null);
}

/** Recipients given as a list or as one comma-separated line. */
function recipients(v: unknown): string[] {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,;]/) : [];
  // Every recipient shows: the card is where the person agrees to who gets the mail.
  return list.map(address).filter((a): a is string => !!a);
}

/** The input as text, each attachment's content replaced by its length: a file's bytes say nothing to read. */
function rawInput(input: Record<string, unknown>): string {
  return JSON.stringify(
    input,
    (key, v: unknown) =>
      key === 'content' && typeof v === 'string' && v.length > 200 ? `… (${v.length})` : v,
    2,
  );
}

/**
 * The mail a connected app's tool call would send, or null when the call is not one. The tool's
 * name says what it does; its input must also name who gets the mail, the mail it answers or
 * forwards, or the draft it sends, so a chat app's `send_message` is not taken for mail.
 */
export function emailPreview(toolName: string, input: Record<string, unknown>): EmailPreview | null {
  const parts = connectionToolParts(toolName);
  if (!parts) return null;
  const kind = KINDS.find(([re]) => re.test(parts.tool))?.[1];
  if (!kind) return null;
  const to = recipients(input.to ?? input.toRecipients);
  const cc = recipients(input.cc ?? input.ccRecipients);
  const bcc = recipients(input.bcc ?? input.bccRecipients);
  const messageId = str(input.messageId) ?? str(input.message_id);
  const draftId = str(input.draftId) ?? str(input.draft_id);
  const named = to.length + cc.length + bcc.length > 0;
  if (kind === 'send' && !named && !draftId) return null;
  if ((kind === 'reply' || kind === 'forward') && !messageId && !named) return null;
  if (kind === 'draft' && !named && !draftId && !str(input.subject)) return null;
  const files = Array.isArray(input.attachments) ? input.attachments : [];
  return {
    kind,
    to,
    cc,
    bcc,
    subject: str(input.subject),
    text: str(input.body) ?? str(input.text) ?? str(input.forwardText) ?? str(input.content),
    html: str(input.htmlBody) ?? str(input.html) ?? str(input.bodyHtml),
    replyAll: input.replyAll === true || parts.tool === 'reply_all',
    signature: input.includeSignature === true,
    attachments: files.map((f: unknown) =>
      f && typeof f === 'object'
        ? (str((f as Record<string, unknown>).filename) ?? str((f as Record<string, unknown>).name) ?? '')
        : '',
    ),
    // A draft being sent as it is; a draft being changed keeps its id but shows its new content.
    draftId: kind === 'send' && draftId ? draftId : null,
    inThread:
      (kind === 'send' || kind === 'draft') &&
      !!(str(input.replyToMessageId) ?? str(input.replyThreadId) ?? str(input.threadId)),
    raw: rawInput(input),
  };
}
