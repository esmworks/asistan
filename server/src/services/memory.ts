import {
  STALE_MEMORY_DAYS,
  type Bot,
  type Memory,
  type MemoryChange,
  type MemoryScope,
} from '@yumakbot/shared';
import { and, asc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import { lastActive, MEMORY_PROMPT_CHARS, withinBudget } from '../runtime/prompt';
import { DOTTED_AND_DOTLESS_I, HttpError, newId, notFound } from '../util';
import { toMemory, toMemoryChange } from './mappers';
import { noteKey } from './secrets';
import { siteMatches } from './vault';
import { MIN_SCORE, type EmbeddingService } from './embeddings';

/** A note whose words hold the query ranks this much above one only near it in meaning. */
const WORD_MATCH_BONUS = 0.25;
/** Notes a search by meaning returns at most. */
const MEANING_HITS = 20;

const fold = (v: string) => v.replace(/[ıİ]/g, 'i').toLowerCase();

export class MemoryService {
  private embeddings: EmbeddingService | null = null;

  constructor(private ctx: Ctx) {}

  /** Search by meaning, once the embedding service exists; until it is set up, search goes by words. */
  useEmbeddings(e: EmbeddingService) {
    this.embeddings = e;
  }

  async list(opts: { scope?: MemoryScope; botId?: string | null } = {}) {
    const conds = [];
    if (opts.scope) conds.push(eq(schema.memories.scope, opts.scope));
    if (opts.botId) conds.push(eq(schema.memories.botId, opts.botId));
    const rows = await this.ctx.db
      .select()
      .from(schema.memories)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(asc(schema.memories.createdAt));
    return rows.map(toMemory);
  }

  /** The notes a bot has about the site of `host`, its own and the shared ones. */
  async forSite(botId: string, host: string): Promise<Memory[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.memories)
      .where(
        and(
          isNotNull(schema.memories.site),
          or(
            eq(schema.memories.scope, 'user'),
            and(eq(schema.memories.scope, 'bot'), eq(schema.memories.botId, botId)),
          ),
        ),
      )
      .orderBy(asc(schema.memories.createdAt));
    const notes = rows.map(toMemory).filter((m) => siteMatches(host, m.site!));
    await this.markUsed(notes.map((m) => m.id));
    return notes;
  }

  /**
   * Records that a bot looked these notes up, which keeps them in the prompt and off the list of
   * notes no bot uses. It is not a change to the note: no history line, no new `updatedAt`. The
   * memory screen is not told either; a page opened in the browser would make it reload each time,
   * and when a note was last used only matters over weeks.
   */
  async markUsed(ids: string[], now = new Date()) {
    if (!ids.length) return;
    await this.ctx.db
      .update(schema.memories)
      .set({ lastUsedAt: now, useCount: sql`${schema.memories.useCount} + 1` })
      .where(inArray(schema.memories.id, ids));
  }

  /** The notes no bot uses any more (see `staleNotes`), the longest unused first. */
  async stale(now = new Date()): Promise<Memory[]> {
    const [notes, bots] = await Promise.all([
      this.list(),
      this.ctx.db
        .select({ id: schema.bots.id, memory: schema.bots.memory })
        .from(schema.bots)
        .where(isNull(schema.bots.archivedAt)),
    ]);
    return staleNotes(notes, bots, now);
  }

  /** What a bot sees: its own memories and the shared user memory. */
  async visibleTo(botId: string): Promise<{ user: Memory[]; bot: Memory[] }> {
    const rows = await this.ctx.db
      .select()
      .from(schema.memories)
      .where(
        and(
          // Notes about a site come with that site, not with every turn.
          isNull(schema.memories.site),
          or(
            eq(schema.memories.scope, 'user'),
            and(eq(schema.memories.scope, 'bot'), eq(schema.memories.botId, botId)),
          ),
        ),
      )
      .orderBy(asc(schema.memories.createdAt));
    const all = rows.map(toMemory);
    return { user: all.filter((m) => m.scope === 'user'), bot: all.filter((m) => m.scope === 'bot') };
  }

  /**
   * Notes whose text holds `query`, or every one of them when there is no query: the own notes of
   * the bots in `botIds` and, unless `shared` is false, the shared user memory. A search with a
   * query counts as using the notes it finds; listing them all does not, as it picks none out.
   */
  async search(botIds: string[], query?: string, shared = true): Promise<Memory[]> {
    const own = and(eq(schema.memories.scope, 'bot'), inArray(schema.memories.botId, botIds));
    const visible = shared ? or(eq(schema.memories.scope, 'user'), own) : own;
    if (query?.trim() && this.embeddings && (await this.embeddings.available())) {
      const rows = await this.ctx.db
        .select()
        .from(schema.memories)
        .where(visible)
        .orderBy(asc(schema.memories.createdAt))
        .limit(5000);
      const scores = await this.embeddings.scores(query, rows);
      if (scores) {
        const needle = fold(query.trim());
        const hits = rows
          .map((r) => ({ r, words: fold(r.content).includes(needle), score: scores.get(r.id) ?? 0 }))
          .filter((h) => h.words || h.score >= MIN_SCORE)
          .sort(
            (a, b) =>
              b.score + (b.words ? WORD_MATCH_BONUS : 0) - (a.score + (a.words ? WORD_MATCH_BONUS : 0)),
          )
          .slice(0, MEANING_HITS);
        await this.markUsed(hits.map((h) => h.r.id));
        return hits.map((h) => toMemory(h.r));
      }
    }
    // ı and İ read as i on both sides, as the message search does.
    const q = query && `%${query.replace(/[ıİ]/g, 'i').replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const rows = await this.ctx.db
      .select()
      .from(schema.memories)
      .where(
        q
          ? and(visible, sql`translate(${schema.memories.content}, ${DOTTED_AND_DOTLESS_I}, 'ii') ilike ${q}`)
          : visible,
      )
      .orderBy(asc(schema.memories.createdAt))
      .limit(q ? 50 : 500);
    if (q) await this.markUsed(rows.map((r) => r.id));
    return rows.map(toMemory);
  }

  /** Whether the note is the shared memory or the own note of one of `botIds`. */
  canEdit(m: Memory, botIds: Iterable<string>) {
    return m.scope === 'user' || (!!m.botId && new Set(botIds).has(m.botId));
  }

  /**
   * A note already saved with the same words (see `noteKey`), in the same place: the shared memory
   * or one bot's own notes, about the same site or none. Writing it again would only repeat it.
   */
  async findSame(input: { scope: MemoryScope; botId: string | null; content: string; site?: string | null }) {
    const rows = await this.ctx.db
      .select()
      .from(schema.memories)
      .where(
        and(
          eq(schema.memories.scope, input.scope),
          input.scope === 'bot' && input.botId
            ? eq(schema.memories.botId, input.botId)
            : isNull(schema.memories.botId),
          input.site ? eq(schema.memories.site, input.site) : isNull(schema.memories.site),
        ),
      );
    const key = noteKey(input.content);
    const row = rows.find((r) => noteKey(r.content) === key);
    return row ? toMemory(row) : null;
  }

  /**
   * Keeps a memory change for the person to accept, instead of making it. The same change asked
   * for again (a daily routine noting the same fact) is kept once.
   */
  async propose(input: Omit<MemoryChange, 'id' | 'createdAt'>): Promise<MemoryChange> {
    const waiting = await this.pending();
    const same = waiting.find(
      (c) =>
        c.action === input.action &&
        c.memoryId === input.memoryId &&
        c.scope === input.scope &&
        c.botId === input.botId &&
        c.site === input.site &&
        noteKey(c.content) === noteKey(input.content),
    );
    if (same) return same;
    const [row] = await this.ctx.db
      .insert(schema.memoryChanges)
      .values({ id: newId(), ...input })
      .returning();
    this.ctx.bus.refresh({ scope: 'memory' });
    return toMemoryChange(row!);
  }

  /** The memory changes waiting for the person, oldest first. */
  async pending(): Promise<MemoryChange[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.memoryChanges)
      .orderBy(asc(schema.memoryChanges.createdAt));
    return rows.map(toMemoryChange);
  }

  /**
   * Makes a waiting change, as the bot asked for it (or with the person's own words for a note
   * they edited before accepting). The note an update or forget was about may be gone by now;
   * then there is nothing left to do.
   */
  async accept(id: string, content?: string): Promise<void> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.memoryChanges)
      .where(eq(schema.memoryChanges.id, id));
    if (!row) throw notFound('memory');
    const words = content?.trim() || row.content;
    const actor = `bot:${row.proposedBy}`;
    if (row.action === 'write') {
      const note = { scope: row.scope, botId: row.botId, content: words, site: row.site };
      if (!(await this.findSame(note))) await this.create({ ...note, source: actor });
    } else if (row.memoryId) {
      const exists = await this.get(row.memoryId).then(
        () => true,
        () => false,
      );
      if (exists && row.action === 'update') await this.update(row.memoryId, { content: words }, actor);
      if (exists && row.action === 'forget') await this.remove(row.memoryId, actor);
    }
    await this.ctx.db.delete(schema.memoryChanges).where(eq(schema.memoryChanges.id, id));
    this.ctx.bus.refresh({ scope: 'memory' });
  }

  async reject(id: string): Promise<void> {
    await this.ctx.db.delete(schema.memoryChanges).where(eq(schema.memoryChanges.id, id));
    this.ctx.bus.refresh({ scope: 'memory' });
  }

  async get(id: string): Promise<Memory> {
    const [row] = await this.ctx.db.select().from(schema.memories).where(eq(schema.memories.id, id)).limit(1);
    if (!row) throw notFound('memory');
    return toMemory(row);
  }

  async create(input: {
    scope: MemoryScope;
    botId: string | null;
    content: string;
    source: string;
    site?: string | null;
  }): Promise<Memory> {
    if (input.scope === 'bot' && !input.botId) throw new HttpError(400, 'error.memoryNeedsBot');
    const [row] = await this.ctx.db
      .insert(schema.memories)
      .values({
        id: newId(),
        scope: input.scope,
        botId: input.scope === 'bot' ? input.botId : null,
        content: input.content,
        site: input.site ?? null,
        source: input.source,
      })
      .returning();
    await this.log(row!.id, 'create', null, row!.content, input.source);
    this.ctx.bus.refresh({ scope: 'memory' });
    this.embeddings?.soon();
    return toMemory(row!);
  }

  async update(id: string, patch: { content: string }, actor: string): Promise<Memory> {
    const before = await this.get(id);
    const [row] = await this.ctx.db
      .update(schema.memories)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(schema.memories.id, id))
      .returning();
    await this.log(id, 'update', before.content, row!.content, actor);
    this.ctx.bus.refresh({ scope: 'memory' });
    this.embeddings?.soon();
    return toMemory(row!);
  }

  async remove(id: string, actor: string) {
    const before = await this.get(id);
    await this.ctx.db.delete(schema.memories).where(eq(schema.memories.id, id));
    await this.log(id, 'delete', before.content, null, actor);
    this.ctx.bus.refresh({ scope: 'memory' });
  }

  /**
   * Deletes every note a bot keeps for itself, in one go. Notes of an archived bot reach no other
   * bot, so this is how a long list left behind (an import, say) goes away. Each note still gets
   * its own line in the history.
   */
  async removeForBot(botId: string, actor: string): Promise<{ count: number }> {
    return this.removeWhere(and(eq(schema.memories.scope, 'bot'), eq(schema.memories.botId, botId))!, actor);
  }

  /** Deletes the notes of `ids` in one go, each with its own line in the history. */
  async removeMany(ids: string[], actor: string): Promise<{ count: number }> {
    if (!ids.length) return { count: 0 };
    return this.removeWhere(inArray(schema.memories.id, ids), actor);
  }

  private async removeWhere(where: SQL, actor: string): Promise<{ count: number }> {
    const rows = await this.ctx.db.transaction(async (tx) => {
      const gone = await tx.delete(schema.memories).where(where).returning();
      if (gone.length) {
        await tx.insert(schema.auditLog).values(
          gone.map((m) => ({
            id: newId(),
            actor,
            action: 'delete',
            targetType: 'memory',
            targetId: m.id,
            before: m.content,
            after: null,
          })),
        );
      }
      return gone;
    });
    if (rows.length) this.ctx.bus.refresh({ scope: 'memory' });
    return { count: rows.length };
  }

  async history(limit = 100) {
    return this.ctx.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.targetType, 'memory'))
      .orderBy(asc(schema.auditLog.createdAt))
      .limit(limit);
  }

  private async log(id: string, action: string, before: string | null, after: string | null, actor: string) {
    await this.ctx.db.insert(schema.auditLog).values({
      id: newId(),
      actor,
      action,
      targetType: 'memory',
      targetId: id,
      before,
      after,
    });
  }
}

/**
 * The notes no bot uses any more: none of them goes into the prompt of a bot that would see it,
 * nobody wrote or changed one in `STALE_MEMORY_DAYS` days, and no bot looked one up in that time. A note in some prompt is
 * never on the list, however old: the bot reads it on every turn, and whether that helps cannot be
 * told from here. Site notes never go into a prompt, so for them only the time counts.
 */
export function staleNotes(
  notes: Memory[],
  bots: Pick<Bot, 'id' | 'memory'>[],
  now: Date,
  budget = MEMORY_PROMPT_CHARS,
): Memory[] {
  const cutoff = new Date(now.getTime() - STALE_MEMORY_DAYS * 86_400_000).toISOString();
  const old = notes.filter((m) => lastActive(m) < cutoff);
  if (!old.length) return [];
  const inPrompt = new Set<string>();
  const shared = notes.filter((m) => m.scope === 'user' && !m.site);
  for (const b of bots) {
    if (!b.memory) continue;
    const own = notes.filter((m) => m.scope === 'bot' && m.botId === b.id && !m.site);
    const fit = withinBudget(shared, own, budget);
    for (const m of [...fit.user, ...fit.bot]) inPrompt.add(m.id);
  }
  return old.filter((m) => !inPrompt.has(m.id)).sort((a, b) => lastActive(a).localeCompare(lastActive(b)));
}
