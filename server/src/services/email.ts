import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { BotEmail, EmailSettings } from '@yumakbot/shared';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import PostalMime from 'postal-mime';
import type { Ctx } from '../context';
import { schema } from '../db';
import { safeFileName } from '../uploads';
import { HttpError, newId, truncate } from '../util';
import { sameSecret } from '../auth';
import type { Services } from './index';
import { registrableSite } from './vault';

type EmailRow = typeof schema.emails.$inferSelect;

/** The most a relay may hand over in one message; providers cap mail at about this. */
export const MAX_EMAIL_BYTES = 25 * 1024 * 1024;
/** A mail's text kept in full up to this; longer ones are cut. */
const MAX_TEXT = 200_000;
const MAX_ATTACHMENTS = 20;
/** What a routine run is handed of a mail's text. */
const PAYLOAD_TEXT = 20_000;
const SECRET_KEY = 'email.inboundSecret';
/** The relay's secret opens only as this key's value, not when moved under another. */
const SECRET_BINDING = ['kv', SECRET_KEY];
/** The part before the @: lowercase letters, digits and . _ -, not at either end. */
const NAME = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

/** How old a mail may be for its sign-in code to be taken; codes expire within minutes. */
const CODE_FRESH_MINUTES = 10;
/** A line that speaks of a code, and what follows it on the line, where the code itself is. */
const CODE_WORDS =
  /(?:code|kod|otp|pin|passcode|verification|verify|doğrulama|onay|güvenlik|security|şifre|password)[^\n]{0,80}/giu;
/** A code: 4 to 8 capital letters and digits, with at least one digit (so not a plain word). */
const CODE = /\b(?=[A-Z0-9]*\d)[A-Z0-9]{4,8}\b/g;

/**
 * The one sign-in code a mail gives: first one near a word that names it ("Your code is 482913"),
 * else the one six-digit number in it. Null when there is none, or more than one could be it, so a
 * guess is never typed into a sign-in page.
 */
export function codeIn(subject: string, text: string): string | null {
  const body = `${subject}\n${text}`;
  const near = new Set<string>();
  for (const line of body.matchAll(CODE_WORDS)) for (const c of line[0].matchAll(CODE)) near.add(c[0]);
  if (near.size) return near.size === 1 ? [...near][0]! : null;
  const six = new Set([...body.matchAll(/\b\d{6}\b/g)].map((m) => m[0]));
  return six.size === 1 ? [...six][0]! : null;
}

/** An HTML mail as plain text: no tags, styles or scripts, entities read, blank runs closed up. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) =>
      text.replace(/<[^>]+>/g, '').trim() === href ? href : `${text} (${href})`,
    )
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const toEmail = (r: EmailRow, workspaces: string): BotEmail => ({
  id: r.id,
  botId: r.botId,
  to: r.to,
  from: r.from,
  fromName: r.fromName,
  subject: r.subject,
  text: r.text,
  attachments: r.attachments.map((a) => ({ ...a, path: join(workspaces, a.path) })),
  receivedAt: r.receivedAt.toISOString(),
  readAt: r.readAt?.toISOString() ?? null,
});

/**
 * Mail addresses for bots. The server runs no mail server: a relay that receives mail for the
 * domain (Cloudflare Email Routing, a mail provider's webhook, a small script) posts each message
 * here with the secret. Mail is kept in the bot's inbox for it to read; it starts the bot's
 * routines that run on mail, and nothing else, since anyone can write any sender on a mail.
 */
export class EmailService {
  constructor(
    private ctx: Ctx,
    private services: Services,
  ) {}

  private get workspaces() {
    return resolve(this.ctx.config.dataDir, 'workspaces');
  }

  /**
   * The relay's secret, kept sealed with the vault key so a copy of the database does not let
   * anyone post mail to the bots; null when there is none or it cannot be opened.
   */
  private async secret(): Promise<string | null> {
    const [row] = await this.ctx.db.select().from(schema.kv).where(eq(schema.kv.key, SECRET_KEY)).limit(1);
    const stored = typeof row?.value === 'string' ? row.value : null;
    if (!stored) return null;
    if (stored.startsWith('v2:')) {
      try {
        return this.services.vault.open(stored, SECRET_BINDING);
      } catch {
        // Sealed with a vault key that is gone: the person makes a new one.
        return null;
      }
    }
    // Kept in the clear before secrets were sealed: sealed now, with the same value, so the relay
    // goes on working.
    await this.store(stored);
    return stored;
  }

  /** Whether `token` is the relay's secret; checked before a message's body is read, too. */
  async accepts(token: string | undefined): Promise<boolean> {
    const secret = await this.secret();
    return !!secret && !!token && sameSecret(secret, token);
  }

  private async store(secret: string) {
    const value = this.services.vault.seal(secret, SECRET_BINDING);
    await this.ctx.db
      .insert(schema.kv)
      .values({ key: SECRET_KEY, value })
      .onConflictDoUpdate({ target: schema.kv.key, set: { value } });
  }

  /** A new secret for the relay; the old one stops working at once. */
  async renewSecret(): Promise<EmailSettings> {
    await this.store(randomBytes(32).toString('base64url'));
    return this.settings();
  }

  async domain(): Promise<string> {
    return ((await this.services.settings.get('emailDomain')) ?? '').toLowerCase();
  }

  async settings(): Promise<EmailSettings> {
    const domain = await this.domain();
    const rows = await this.ctx.db.select().from(schema.emailAddresses);
    return {
      domain,
      secret: await this.secret(),
      addresses: rows
        .filter((r) => r.botId)
        .map((r) => ({
          botId: r.botId!,
          name: r.name,
          address: domain ? `${r.name}@${domain}` : null,
          codes: r.signInCodes,
        })),
    };
  }

  /** The bot's address, when it has one and a domain is set. */
  async addressOf(botId: string): Promise<string | null> {
    const domain = await this.domain();
    if (!domain) return null;
    const [row] = await this.ctx.db
      .select()
      .from(schema.emailAddresses)
      .where(eq(schema.emailAddresses.botId, botId))
      .limit(1);
    return row ? `${row.name}@${domain}` : null;
  }

  /**
   * Gives the bot an address under `name`. A name once given is never another bot's; the bot's
   * previous address, if any, stays taken but no longer reaches it.
   */
  async claim(botId: string, raw: string): Promise<EmailSettings> {
    await this.services.bots.get(botId);
    const name = raw.trim().toLowerCase();
    if (!NAME.test(name)) throw new HttpError(400, 'error.emailName');
    const [taken] = await this.ctx.db
      .select()
      .from(schema.emailAddresses)
      .where(eq(schema.emailAddresses.name, name))
      .limit(1);
    if (taken && taken.botId !== botId) throw new HttpError(409, 'error.emailNameTaken');
    if (!taken) {
      await this.release(botId);
      await this.ctx.db.insert(schema.emailAddresses).values({ name, botId });
    }
    this.ctx.bus.refresh({ scope: 'info' });
    return this.settings();
  }

  /** Lets the bot take sign-in codes from its mail, or stops it. */
  async setCodes(botId: string, on: boolean): Promise<EmailSettings> {
    const [row] = await this.ctx.db
      .update(schema.emailAddresses)
      .set({ signInCodes: on })
      .where(eq(schema.emailAddresses.botId, botId))
      .returning();
    if (!row) throw new HttpError(409, 'error.emailNoAddress');
    this.ctx.bus.refresh({ scope: 'info' });
    return this.settings();
  }

  /** Whether the bot has an address and may take sign-in codes from mail to it. */
  async codesAllowed(botId: string): Promise<boolean> {
    const [row] = await this.ctx.db
      .select({ on: schema.emailAddresses.signInCodes })
      .from(schema.emailAddresses)
      .where(eq(schema.emailAddresses.botId, botId))
      .limit(1);
    return !!row?.on && !!(await this.domain());
  }

  /**
   * The code in the newest unread mail from `site` (by the sender's domain) that came in the last
   * few minutes, with the mail's id so it is marked used (`codeUsed`) only once the code is typed.
   * The sender of a mail can be forged, so this only keeps a code from one site out of another
   * site's page: the code is typed into that site's own field, where a forged one only fails. Null
   * when there is no such mail; `unclear` when one came but its code could not be told apart.
   */
  async findCode(
    botId: string,
    site: string,
  ): Promise<{ id: string; code: string; from: string } | { unclear: true } | null> {
    if (!(await this.codesAllowed(botId))) return null;
    const rows = await this.ctx.db
      .select()
      .from(schema.emails)
      .where(
        and(
          eq(schema.emails.botId, botId),
          isNull(schema.emails.readAt),
          // The database's own clock, the one that stamped the mail.
          gt(schema.emails.receivedAt, sql`now() - make_interval(mins => ${CODE_FRESH_MINUTES})`),
        ),
      )
      .orderBy(desc(schema.emails.receivedAt))
      .limit(20);
    const mail = rows.find((r) => registrableSite(r.from.split('@')[1] ?? '') === site);
    if (!mail) return null;
    const code = codeIn(mail.subject, mail.text);
    return code ? { id: mail.id, code, from: mail.from } : { unclear: true };
  }

  /** Marks the mail a code was typed from as read, so its code is not typed again. */
  async codeUsed(botId: string, id: string) {
    await this.ctx.db
      .update(schema.emails)
      .set({ readAt: new Date() })
      .where(and(eq(schema.emails.id, id), eq(schema.emails.botId, botId)));
    this.ctx.bus.refresh({ scope: 'info' });
  }

  /** Waits for `findCode` to find a mail, up to `waitMs`; the turn being stopped ends the wait. */
  async waitForCode(botId: string, site: string, waitMs: number, signal?: AbortSignal) {
    const until = Date.now() + waitMs;
    for (;;) {
      const found = await this.findCode(botId, site);
      if (found || Date.now() >= until || signal?.aborted) return found;
      await new Promise((r) => setTimeout(r, Math.min(1000, Math.max(0, until - Date.now()))));
    }
  }

  async release(botId: string): Promise<void> {
    await this.ctx.db
      .update(schema.emailAddresses)
      .set({ botId: null })
      .where(eq(schema.emailAddresses.botId, botId));
    this.ctx.bus.refresh({ scope: 'info' });
  }

  /**
   * A message the relay hands over for one recipient. Mail for an address nobody has is dropped
   * quietly, so the relay neither retries nor bounces it; the same mail twice is kept once.
   */
  async receive(
    token: string | undefined,
    to: string,
    raw: Buffer,
  ): Promise<'saved' | 'dropped' | 'duplicate'> {
    if (!(await this.accepts(token))) throw new HttpError(401, 'error.emailSecret');
    const domain = await this.domain();
    const [local = '', host = ''] = to.trim().toLowerCase().split('@');
    // `name+anything@` reaches `name@`, as most mail services do.
    const name = local.split('+')[0]!;
    if (!domain || host !== domain || !NAME.test(name)) return 'dropped';
    const [addr] = await this.ctx.db
      .select()
      .from(schema.emailAddresses)
      .where(eq(schema.emailAddresses.name, name))
      .limit(1);
    if (!addr?.botId) return 'dropped';
    const bot = await this.services.bots.get(addr.botId).catch(() => null);
    if (!bot || bot.archivedAt) return 'dropped';

    const mail = await PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer' });
    const id = newId();
    const text = truncate(mail.text?.trim() || htmlToText(mail.html ?? ''), MAX_TEXT);
    const [inserted] = await this.ctx.db
      .insert(schema.emails)
      .values({
        id,
        botId: bot.id,
        to: `${name}@${domain}`,
        from: (mail.from?.address ?? '').toLowerCase().slice(0, 320),
        fromName: (mail.from?.name ?? '').slice(0, 200),
        subject: (mail.subject ?? '').slice(0, 1000),
        text,
        messageId: mail.messageId?.slice(0, 500) || null,
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted) return 'duplicate';
    // Attachments go in the bot's own folder, where its file tools read them.
    const dir = join(this.workspaces, 'bots', bot.id, 'files', 'mail', id);
    const attachments: { name: string; size: number; path: string }[] = [];
    for (const a of mail.attachments.slice(0, MAX_ATTACHMENTS)) {
      const data =
        typeof a.content === 'string'
          ? Buffer.from(a.content, 'utf8')
          : Buffer.from(new Uint8Array(a.content));
      const base = safeFileName(a.filename ?? '') || `${attachments.length + 1}.bin`;
      let file = base;
      for (let n = 2; attachments.some((x) => x.name === file); n++) file = `${n}-${base}`;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const full = join(dir, file);
      writeFileSync(full, data, { mode: 0o600 });
      attachments.push({ name: file, size: data.length, path: relative(this.workspaces, full) });
    }
    const [row] = attachments.length
      ? await this.ctx.db
          .update(schema.emails)
          .set({ attachments })
          .where(eq(schema.emails.id, id))
          .returning()
      : [inserted];
    if (!row) return 'duplicate';
    this.ctx.bus.refresh({ scope: 'info' });
    await this.services.routines
      .runFromEmail(bot.id, toEmail(row, this.workspaces))
      .catch((err) => console.error(`Routines for mail ${row.id} failed to start`, err));
    return 'saved';
  }

  /** The bot's latest mail, newest first. */
  async inbox(botId: string, opts: { limit?: number; unread?: boolean } = {}): Promise<BotEmail[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.emails)
      .where(
        opts.unread
          ? and(eq(schema.emails.botId, botId), isNull(schema.emails.readAt))
          : eq(schema.emails.botId, botId),
      )
      .orderBy(desc(schema.emails.receivedAt))
      .limit(Math.min(opts.limit ?? 20, 100));
    return rows.map((r) => toEmail(r, this.workspaces));
  }

  /** One mail of the bot's, marked read; null when it has no such mail. */
  async read(botId: string, id: string): Promise<BotEmail | null> {
    const [row] = await this.ctx.db
      .update(schema.emails)
      .set({ readAt: new Date() })
      .where(and(eq(schema.emails.id, id), eq(schema.emails.botId, botId)))
      .returning();
    return row ? toEmail(row, this.workspaces) : null;
  }
}

/** A mail as a bot is handed it: who, what, when, the text, and where its attachments are. */
export function mailText(
  m: BotEmail,
  labels: { from: string; to: string; subject: string; date: string; files: string },
) {
  const from = m.fromName ? `${m.fromName} <${m.from}>` : m.from;
  return [
    `${labels.from}: ${from}`,
    `${labels.to}: ${m.to}`,
    `${labels.subject}: ${m.subject}`,
    `${labels.date}: ${m.receivedAt}`,
    '',
    truncate(m.text, PAYLOAD_TEXT),
    m.attachments.length
      ? `\n${labels.files}:\n${m.attachments.map((a) => `- ${a.path} (${a.size} B)`).join('\n')}`
      : '',
  ]
    .join('\n')
    .trim();
}
