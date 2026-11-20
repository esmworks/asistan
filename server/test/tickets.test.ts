import type { Thread, Ticket } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testServer, type TestServer } from './helpers';

describe('görev panosu', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(async () => {
    await t.dispose();
  });

  const ticket = async (id: string) =>
    (await t.api<Ticket[]>('GET', '/api/tickets')).body.find((k) => k.id === id)!;

  it('bota verilen görev kendi konuşmasında başlar; yanıt yorum olur, görev incelemeye geçer', async () => {
    const bot = await t.bot({ name: 'Yazar' });
    const made = await t.api<Ticket>('POST', '/api/tickets', {
      title: 'Bülteni yaz',
      description: 'Kasım bültenini hazırla.',
      priority: 'high',
      assigneeBotId: bot.id,
    });
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ number: 1, status: 'in_progress' });
    await t.services.turns.idle();
    const k = await ticket(made.body.id);
    expect(k.status).toBe('in_review');
    expect(k.comments).toHaveLength(1);
    expect(k.comments[0]!.author).toBe(`bot:${bot.id}`);
    // The work ran in the ticket's own conversation, with the ticket in its prompt.
    const thread = (await t.api<Thread[]>('GET', `/api/bots/${bot.id}/threads`)).body.find(
      (th) => th.id === k.threadId,
    )!;
    expect(thread.kind).toBe('ticket');
    expect(t.engine.requests.at(-1)!.prompt).toContain('Kasım bültenini hazırla.');

    // The person's comment sends the bot back to it.
    await t.api('POST', `/api/tickets/${k.id}/comments`, { text: 'Biraz daha kısa olsun.' });
    await t.services.turns.idle();
    expect(t.engine.requests.at(-1)!.prompt).toContain('Biraz daha kısa olsun.');
    const after = await ticket(k.id);
    expect(after.status).toBe('in_review');
    expect(after.comments.map((c) => c.author)).toEqual([`bot:${bot.id}`, 'user', `bot:${bot.id}`]);

    // Numbers grow; done tickets do not start anything.
    const second = await t.api<Ticket>('POST', '/api/tickets', { title: 'İkinci' });
    expect(second.body).toMatchObject({ number: 2, status: 'todo', assigneeBotId: null });
    await t.api('PATCH', `/api/tickets/${k.id}`, { status: 'done' });
    const before = t.engine.requests.length;
    await t.api('POST', `/api/tickets/${k.id}/comments`, { text: 'Teşekkürler' });
    await t.services.turns.idle();
    expect(t.engine.requests.length).toBe(before);
  });

  it('bot görev açıp başka bota verebilir; görev üstünde çalışırken açtığı görev kullanıcıyı bekler', async () => {
    const lead = await t.bot({ name: 'Lider' });
    const helper = await t.bot({ name: 'Yardımcı' });
    const main = (await t.api<Thread>('GET', `/api/bots/${lead.id}/main-thread`)).body;
    // The helper's ticket, when it works on it, asks it to open one for the lead.
    const inner = `[araç:ticket_create ${JSON.stringify({ title: 'Geri bildirim ver', assign_to: 'Lider' })}]`;
    const outer = { title: 'Rakipleri araştır', description: inner, assign_to: 'Yardımcı' };
    await t.send(main.id, `[araç:ticket_create ${JSON.stringify(outer)}]`);
    await t.services.turns.idle();
    const list = (await t.api<Ticket[]>('GET', '/api/tickets')).body;
    const research = list.find((k) => k.title === 'Rakipleri araştır')!;
    expect(research).toMatchObject({
      assigneeBotId: helper.id,
      createdBy: `bot:${lead.id}`,
      status: 'in_review',
    });
    // Opened during ticket work: assigned, but waiting for the person.
    const feedback = list.find((k) => k.title === 'Geri bildirim ver')!;
    expect(feedback).toMatchObject({ assigneeBotId: lead.id, createdBy: `bot:${helper.id}`, status: 'todo' });
    expect(feedback.threadId).toBeNull();
    // The person starts it.
    await t.api('PATCH', `/api/tickets/${feedback.id}`, { status: 'in_progress' });
    await t.services.turns.idle();
    expect((await ticket(feedback.id)).status).toBe('in_review');
  });

  it('görevler sütunda verilen sırada durur; başka sütuna geçen görev en üste gelir', async () => {
    const make = async (title: string) => (await t.api<Ticket>('POST', '/api/tickets', { title })).body;
    const a = await make('Bir');
    const b = await make('İki');
    const c = await make('Üç');
    const order = async (status: string) =>
      (await t.api<Ticket[]>('GET', '/api/tickets')).body
        .filter((k) => k.status === status)
        .sort((x, y) => x.position - y.position)
        .map((k) => k.title);
    // The newest stands first.
    expect(await order('todo')).toEqual(['Üç', 'İki', 'Bir']);
    // Put between two others, it takes a place between theirs.
    const [first, second] = [await ticket(c.id), await ticket(b.id)];
    await t.api('PATCH', `/api/tickets/${a.id}`, { position: (first.position + second.position) / 2 });
    expect(await order('todo')).toEqual(['Üç', 'Bir', 'İki']);
    // Moved to another column with no place given, it goes to the top there.
    await t.api('PATCH', `/api/tickets/${b.id}`, { status: 'done' });
    await t.api('PATCH', `/api/tickets/${c.id}`, { status: 'done' });
    expect(await order('done')).toEqual(['Üç', 'İki']);
    // A ticket says whether its bot is at work on it, so a board opened mid-turn shows it.
    expect((await ticket(a.id)).turnState).toBe('idle');
    const bot = await t.bot({ name: 'Yavaş' });
    const slow = (
      await t.api<Ticket>('POST', '/api/tickets', {
        title: 'Uzun iş',
        description: '[bekle:300]',
        assigneeBotId: bot.id,
      })
    ).body;
    expect(['queued', 'running']).toContain((await ticket(slow.id)).turnState);
    await t.services.turns.idle();
    expect((await ticket(slow.id)).turnState).toBe('idle');
  });
});
