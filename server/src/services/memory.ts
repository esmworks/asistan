import type { Memory, MemoryScope } from '@yumakbot/shared';
import { and, asc, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import { DOTTED_AND_DOTLESS_I, HttpError, newId, notFound } from '../util';
import { toMemory } from './mappers';
import { siteMatches } from './vault';

export class MemoryService {
  constructor(private ctx: Ctx) {}

  async list(opts: { scope?: MemoryScope; botId?: string | null; status?: Memory['status'] } = {}) {
    const conds = [];
    if (opts.scope) conds.push(eq(schema.memories.scope, opts.scope));
    if (opts.botId) conds.push(eq(schema.memories.botId, opts.botId));
    if (opts.status) conds.push(eq(schema.memories.status, opts.status));
    const rows = await this.ctx.db
      .select()
      .from(schema.memories)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(asc(schema.memories.createdAt));
    return rows.map(toMemory);
  }

  /** The active notes a bot has about the site of `host`, its own and the shared ones. */
  async forSite(botId: string, host: string): Promise<Memory[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.memories)
      .where(
        and(
          eq(schema.memories.status, 'active'),
          isNotNull(schema.memories.site),
          or(
            eq(schema.memories.scope, 'user'),
            and(eq(schema.memories.scope, 'bot'), eq(schema.memories.botId, botId)),
          ),
        ),
      )
      .orderBy(asc(schema.memories.createdAt));
    return rows.map(toMemory).filter((m) => siteMatches(host, m.site!));
  }

  /** What a bot sees: its own memories and the shared user memory (active only). */
  async visibleTo(botId: string): Promise<{ user: Memory[]; bot: Memory[] }> {
    const rows = await this.ctx.db
      .select()
      .from(schema.memories)
      .where(
        and(
          eq(schema.memories.status, 'active'),
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

  async search(botId: string, query: string): Promise<Memory[]> {
    // ı and İ read as i on both sides, as the message search does.
    const q = `%${query.replace(/[ıİ]/g, 'i').replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const rows = await this.ctx.db
      .select()
      .from(schema.memories)
      .where(
        and(
          eq(schema.memories.status, 'active'),
          sql`translate(${schema.memories.content}, ${DOTTED_AND_DOTLESS_I}, 'ii') ilike ${q}`,
          or(
            eq(schema.memories.scope, 'user'),
            and(eq(schema.memories.scope, 'bot'), eq(schema.memories.botId, botId)),
          ),
        ),
      )
      .limit(50);
    return rows.map(toMemory);
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
    status: Memory['status'];
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
        status: input.status,
        source: input.source,
      })
      .returning();
    await this.log(row!.id, 'create', null, row!.content, input.source);
    this.ctx.bus.refresh({ scope: 'memory' });
    return toMemory(row!);
  }

  async update(id: string, patch: { content?: string; status?: 'active' }, actor: string): Promise<Memory> {
    const before = await this.get(id);
    const [row] = await this.ctx.db
      .update(schema.memories)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(schema.memories.id, id))
      .returning();
    await this.log(
      id,
      patch.status === 'active' && before.status === 'proposed' ? 'approve' : 'update',
      before.content,
      row!.content,
      actor,
    );
    this.ctx.bus.refresh({ scope: 'memory' });
    return toMemory(row!);
  }

  async remove(id: string, actor: string) {
    const before = await this.get(id);
    await this.ctx.db.delete(schema.memories).where(eq(schema.memories.id, id));
    await this.log(id, 'delete', before.content, null, actor);
    this.ctx.bus.refresh({ scope: 'memory' });
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
