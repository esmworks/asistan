import type { Skill, Thread, Ticket } from '@yumakbot/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { OWNER_ID } from '../src/users';
import { testServer, type TestServer } from './helpers';

describe('kimin yaptığı', () => {
  let t: TestServer;
  beforeAll(async () => {
    t = await testServer();
  });
  afterAll(() => t.dispose());

  it('kişinin mesajı ve başlattığı tur o kişiye yazılır', async () => {
    const bot = await t.bot();
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    const message = await t.send(thread.id, 'merhaba');
    await t.services.turns.idle();
    const [row] = await t.services.ctx.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, message.id));
    expect(row!.userId).toBe(OWNER_ID);
    const [turn] = await t.services.ctx.db
      .select()
      .from(schema.turns)
      .where(eq(schema.turns.id, row!.turnId!));
    expect(turn!.userId).toBe(OWNER_ID);
    // The bot's answer is no person's message.
    const answers = await t.services.ctx.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.threadId, thread.id));
    expect(answers.filter((m) => m.role === 'assistant').every((m) => m.userId === null)).toBe(true);
  });

  it('bir botun başka bota verdiği iş, isteyen kişi adına çalışır', async () => {
    const asking = await t.bot();
    const asked = await t.bot();
    const thread = (await t.api<Thread>('GET', `/api/bots/${asking.id}/main-thread`)).body;
    const message = await t.send(thread.id, 'sor');
    await t.services.turns.idle();
    const [row] = await t.services.ctx.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, message.id));
    const jobId = 'job-attrib';
    const askedThread = (await t.api<Thread>('GET', `/api/bots/${asked.id}/main-thread`)).body;
    await t.services.ctx.db.insert(schema.jobs).values({
      id: jobId,
      rootId: jobId,
      depth: 1,
      kind: 'ask',
      fromBotId: asking.id,
      toBotId: asked.id,
      fromThreadId: thread.id,
      fromTurnId: row!.turnId,
      toThreadId: askedThread.id,
      request: 'bir iş',
      status: 'pending',
    });
    const turn = await t.services.turns.enqueue({
      threadId: askedThread.id,
      botId: asked.id,
      source: 'bot',
      prompt: 'iş',
      jobId,
    });
    expect(turn.userId).toBe(OWNER_ID);
    await t.services.turns.idle();
  });

  it('bilet ve beceri, açan kişiyi taşır', async () => {
    const ticket = (await t.api<Ticket>('POST', '/api/tickets', { title: 'Rapor' })).body;
    const [tr] = await t.services.ctx.db
      .select()
      .from(schema.tickets)
      .where(eq(schema.tickets.id, ticket.id));
    expect(tr!.createdByUserId).toBe(OWNER_ID);
    const skill = (
      await t.api<Skill>('POST', '/api/skills', { name: 'rapor-yaz', description: 'Rapor yazar' })
    ).body;
    const [sr] = await t.services.ctx.db.select().from(schema.skills).where(eq(schema.skills.id, skill.id));
    expect(sr!.createdByUserId).toBe(OWNER_ID);
  });
});
