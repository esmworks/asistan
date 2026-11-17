import { randomBytes } from 'node:crypto';
import type { PageShare } from '@yumakbot/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';

type Row = typeof schema.pageShares.$inferSelect;

const toShare = (r: Row): PageShare => ({
  token: r.token,
  botId: r.botId,
  path: r.path,
  name: r.name,
  createdAt: r.createdAt.toISOString(),
});

/** A link token: long enough that guessing one is hopeless, and safe in a URL. */
export const shareToken = () => randomBytes(24).toString('base64url');
const TOKEN = /^[A-Za-z0-9_-]{20,64}$/;

/**
 * Links that open a bot's page for anyone who has them. One link per page: sharing a page again
 * gives the same link, and turning it off makes the next share a new one.
 */
export class PageShareService {
  constructor(private ctx: Ctx) {}

  async list(): Promise<PageShare[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.pageShares)
      .orderBy(desc(schema.pageShares.createdAt));
    return rows.map(toShare);
  }

  async find(botId: string, path: string): Promise<PageShare | null> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.pageShares)
      .where(and(eq(schema.pageShares.botId, botId), eq(schema.pageShares.path, path)))
      .limit(1);
    return row ? toShare(row) : null;
  }

  async share(botId: string, path: string, name: string): Promise<PageShare> {
    const existing = await this.find(botId, path);
    if (existing) return existing;
    const [row] = await this.ctx.db
      .insert(schema.pageShares)
      .values({ token: shareToken(), botId, path, name })
      .onConflictDoNothing()
      .returning();
    // Two shares at once: the other one's link stands.
    return row ? toShare(row) : (await this.find(botId, path))!;
  }

  async unshare(token: string): Promise<void> {
    await this.ctx.db.delete(schema.pageShares).where(eq(schema.pageShares.token, token));
  }

  /** The page a link opens; null for a token that is malformed, turned off or never was. */
  async resolve(token: string): Promise<PageShare | null> {
    if (!TOKEN.test(token)) return null;
    const [row] = await this.ctx.db
      .select()
      .from(schema.pageShares)
      .where(eq(schema.pageShares.token, token))
      .limit(1);
    return row ? toShare(row) : null;
  }
}
