import { createHash } from 'node:crypto';
import type { Bot } from '@yumakbot/shared';
import { and, eq, isNotNull, isNull, lt, or } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import { HttpError, newId, notFound } from '../util';
import { toBot } from './mappers';
import { serverTranslator } from './settings';
import { fetchPublicText } from './skill-link';
import type { ThreadService } from './threads';

/** The longest instructions a bot takes, as the bot form allows. */
export const INSTRUCTIONS_MAX = 20_000;
/** The largest document read: a web page carries far more markup than text. */
const DOC_MAX = 2 * 1024 * 1024;
/** How long after a look at a document the next one is due: once a day. */
export const DOC_CHECK_EVERY_MS = 23 * 60 * 60_000;

/**
 * The address that serves a document's text: a GitHub page of a file becomes its raw address;
 * any other https address is read as it is. A redirect is not followed (see `fetchPublicText`).
 */
export function instructionsDocUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new HttpError(400, 'error.skillLinkInvalid');
  }
  if (url.protocol !== 'https:') throw new HttpError(400, 'error.skillLinkHttps');
  if (url.hostname === 'github.com') {
    const [owner, repo, kind, ref, ...rest] = url.pathname.split('/').filter(Boolean);
    if (owner && repo && kind === 'blob' && ref && rest.length)
      return new URL(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${rest.join('/')}`);
  }
  return url;
}

const ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
};

/**
 * A document's text as instructions: plain text and Markdown as they are, a web page with its
 * markup taken out but its paragraphs and list items kept on lines of their own.
 */
export function documentText(raw: string): string {
  let text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (/^\s*(<!doctype html|<html[\s>])/i.test(text) || /<(body|p|div|li|h[1-6])[\s>]/i.test(text)) {
    text = text
      .replace(/<(script|style|noscript|template|head)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<li\b[^>]*>/gi, '\n- ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/?(p|div|section|article|h[1-6]|ul|ol|tr|table|blockquote|pre)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/g, (_, e: string) => ENTITIES[e] ?? '');
    text = text
      .split('\n')
      .map((l) => l.replace(/[ \t]+/g, ' ').trim())
      .join('\n');
  }
  return text
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const fingerprint = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * Instructions kept in a document the person (or whoever owns the process) edits elsewhere. The
 * document is read once a day and on request, with no AI. A change never reaches the bot by
 * itself: it waits as `instructionsPending` until the person accepts it or turns it down, and a
 * document turned down is not offered again until it changes once more.
 */
export class InstructionDocService {
  constructor(
    private ctx: Ctx,
    private threads: ThreadService,
    /** Tests pass a stand-in for reading the document. */
    private read: (url: URL) => Promise<string> = (url) => fetchPublicText(url, DOC_MAX),
  ) {}

  private async row(botId: string) {
    const [row] = await this.ctx.db.select().from(schema.bots).where(eq(schema.bots.id, botId)).limit(1);
    if (!row) throw notFound('bot');
    return row;
  }

  /** Reads a bot's document now; what differs from its instructions then waits for the person. */
  async check(botId: string, now = new Date()): Promise<Bot> {
    const bot = await this.row(botId);
    if (!bot.instructionsUrl) throw new HttpError(400, 'error.instructionsNotLinked');
    const url = bot.instructionsUrl;
    let text: string;
    try {
      text = documentText(await this.read(instructionsDocUrl(url)));
      if (!text) throw new HttpError(400, 'error.instructionsDocEmpty');
      if (text.length > INSTRUCTIONS_MAX)
        throw new HttpError(400, 'error.instructionsDocTooLong', { max: String(INSTRUCTIONS_MAX) });
    } catch (err) {
      const t = await serverTranslator(this.ctx);
      const why = err instanceof HttpError ? err.localized(t) : t('error.skillLinkUnreachable');
      return this.save(botId, url, { instructionsError: why, instructionsCheckedAt: now });
    }
    const hash = fingerprint(text);
    const pending = text === bot.instructions || hash === bot.instructionsDocHash ? null : text;
    const fresh = pending !== null && pending !== bot.instructionsPending;
    const saved = await this.save(botId, url, {
      instructionsPending: pending,
      // The instructions are what the document says: that counts as accepted.
      ...(text === bot.instructions && { instructionsDocHash: hash }),
      instructionsError: null,
      instructionsCheckedAt: now,
    });
    // The person hears of it where they talk to the bot; the text itself waits in the bot's panel.
    if (fresh && saved.instructionsPending === pending) {
      const t = await serverTranslator(this.ctx);
      const thread = await this.threads.main(botId);
      await this.threads.addMessage({
        threadId: thread.id,
        role: 'system',
        author: 'system',
        text: t('instructions.docChanged'),
      });
    }
    return saved;
  }

  /**
   * Writes what a look at the document found, unless the bot was linked to another document (or
   * none) meanwhile: then that look is old news.
   */
  private async save(
    botId: string,
    url: string,
    set: Partial<typeof schema.bots.$inferInsert>,
  ): Promise<Bot> {
    const [row] = await this.ctx.db
      .update(schema.bots)
      .set(set)
      .where(and(eq(schema.bots.id, botId), eq(schema.bots.instructionsUrl, url)))
      .returning();
    this.ctx.bus.refresh({ scope: 'bots' });
    return toBot(row ?? (await this.row(botId)));
  }

  /** Looks at every document whose daily look is due, one after another. */
  async checkDue(now = new Date()): Promise<void> {
    const due = await this.ctx.db
      .select({ id: schema.bots.id })
      .from(schema.bots)
      .where(
        and(
          isNotNull(schema.bots.instructionsUrl),
          isNull(schema.bots.archivedAt),
          or(
            isNull(schema.bots.instructionsCheckedAt),
            lt(schema.bots.instructionsCheckedAt, new Date(now.getTime() - DOC_CHECK_EVERY_MS)),
          ),
        ),
      );
    for (const { id } of due) {
      await this.check(id, now).catch((err: unknown) =>
        console.warn(`Instructions document of bot ${id} could not be looked at: ${String(err)}`),
      );
    }
  }

  /** The person takes the document's text as the bot's instructions; the change is kept on record. */
  async accept(botId: string, expected?: string): Promise<Bot> {
    const bot = await this.row(botId);
    const text = bot.instructionsPending;
    // The text on the person's screen is the text they accept: a newer one waits for its own look.
    if (text === null || (expected !== undefined && expected !== text))
      throw new HttpError(409, 'error.instructionsChanged');
    const row = await this.ctx.db.transaction(async (tx) => {
      const [saved] = await tx
        .update(schema.bots)
        .set({
          instructions: text,
          instructionsPending: null,
          instructionsDocHash: fingerprint(text),
          updatedAt: new Date(),
        })
        .where(and(eq(schema.bots.id, botId), eq(schema.bots.instructionsPending, text)))
        .returning();
      if (!saved) throw new HttpError(409, 'error.instructionsChanged');
      await tx.insert(schema.auditLog).values({
        id: newId(),
        actor: 'user',
        action: 'instructions.document',
        targetType: 'bot',
        targetId: botId,
        before: { instructions: bot.instructions, url: bot.instructionsUrl },
        after: { instructions: text, url: bot.instructionsUrl },
      });
      return saved;
    });
    this.ctx.bus.refresh({ scope: 'bots' });
    return toBot(row);
  }

  /** The person turns the document's text down; it is not offered again until it changes. */
  async decline(botId: string): Promise<Bot> {
    const bot = await this.row(botId);
    if (bot.instructionsPending === null) return toBot(bot);
    const [row] = await this.ctx.db
      .update(schema.bots)
      .set({ instructionsPending: null, instructionsDocHash: fingerprint(bot.instructionsPending) })
      .where(eq(schema.bots.id, botId))
      .returning();
    this.ctx.bus.refresh({ scope: 'bots' });
    return toBot(row!);
  }
}
