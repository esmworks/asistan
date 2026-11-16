import { STALE_MEMORY_DAYS, type Bot, type Memory, type MemoryScope } from '@yumakbot/shared';
import { and, asc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import { lastActive, MEMORY_PROMPT_CHARS, withinBudget } from '../runtime/prompt';
import { DOTTED_AND_DOTLESS_I, HttpError, newId, notFound } from '../util';
import { toMemory } from './mappers';
import { siteMatches } from './vault';

export class MemoryService {
  constructor(private ctx: Ctx) {}

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
