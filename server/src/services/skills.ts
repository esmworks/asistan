import type { Skill, SkillCreate, SkillUpdate } from '@yumakbot/shared';
import { asc, and, eq } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import { HttpError, isUniqueViolation, newId, notFound } from '../util';

type Row = typeof schema.skills.$inferSelect;

const toSkill = (r: Row, botIds: string[]): Skill => ({
  id: r.id,
  name: r.name,
  description: r.description,
  body: r.body,
  botIds,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

/**
 * Skills: written instructions for a kind of task, kept once and turned on per bot. A bot sees
 * the name and description of each skill it has, and reads the rest when a task calls for it.
 */
export class SkillService {
  constructor(private ctx: Ctx) {}

  async list(): Promise<Skill[]> {
    const rows = await this.ctx.db.select().from(schema.skills).orderBy(asc(schema.skills.name));
    const links = await this.ctx.db.select().from(schema.botSkills);
    return rows.map((r) =>
      toSkill(
        r,
        links.filter((l) => l.skillId === r.id).map((l) => l.botId),
      ),
    );
  }

  async get(id: string): Promise<Skill> {
    const skill = (await this.list()).find((s) => s.id === id);
    if (!skill) throw notFound('skill');
    return skill;
  }

  /** The skills a bot has on, by name. */
  async forBot(botId: string): Promise<Skill[]> {
    return (await this.list()).filter((s) => s.botIds.includes(botId));
  }

  async create(input: SkillCreate): Promise<Skill> {
    const id = newId();
    try {
      await this.ctx.db.insert(schema.skills).values({
        id,
        name: input.name,
        description: input.description,
        body: input.body ?? '',
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'error.skillExists', { name: input.name });
      throw err;
    }
    for (const botId of input.botIds ?? []) await this.setBot(id, botId, true, false);
    this.changed();
    return this.get(id);
  }

  async update(id: string, patch: SkillUpdate): Promise<Skill> {
    await this.get(id);
    try {
      await this.ctx.db
        .update(schema.skills)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(schema.skills.id, id));
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'error.skillExists', { name: patch.name ?? '' });
      throw err;
    }
    this.changed();
    return this.get(id);
  }

  async remove(id: string) {
    await this.get(id);
    await this.ctx.db.delete(schema.skills).where(eq(schema.skills.id, id));
    this.changed();
  }

  async setBot(skillId: string, botId: string, on: boolean, notify = true): Promise<void> {
    const [bot] = await this.ctx.db
      .select({ id: schema.bots.id })
      .from(schema.bots)
      .where(eq(schema.bots.id, botId))
      .limit(1);
    if (!bot) throw notFound('bot');
    if (on) {
      await this.ctx.db.insert(schema.botSkills).values({ botId, skillId }).onConflictDoNothing();
    } else {
      await this.ctx.db
        .delete(schema.botSkills)
        .where(and(eq(schema.botSkills.botId, botId), eq(schema.botSkills.skillId, skillId)));
    }
    if (notify) this.changed();
  }

  private changed() {
    this.ctx.bus.refresh({ scope: 'skills' });
  }
}
