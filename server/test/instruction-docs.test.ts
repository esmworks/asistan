import type { Bot } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OWNER_ID } from '../src/users';
import { schema } from '../src/db';
import { HttpError } from '../src/util';
import { documentText, instructionsDocUrl } from '../src/services/instruction-docs';
import { testServer, type TestServer } from './helpers';

const DOC = 'https://example.com/handbook.md';

describe('reading an instructions document', () => {
  it('reads a GitHub page of a file from its raw address', () => {
    expect(instructionsDocUrl('https://github.com/acme/ops/blob/main/billing/BOT.md').href).toBe(
      'https://raw.githubusercontent.com/acme/ops/main/billing/BOT.md',
    );
    expect(instructionsDocUrl('https://example.com/a.txt').href).toBe('https://example.com/a.txt');
    expect(() => instructionsDocUrl('http://example.com/a.txt')).toThrow(HttpError);
    expect(() => instructionsDocUrl('not a link')).toThrow(HttpError);
  });

  it('keeps Markdown as it is, and a web page as lines of text', () => {
    expect(documentText('# Billing\r\n\r\n\r\n- Send invoices daily  \n')).toBe(
      '# Billing\n\n- Send invoices daily',
    );
    const page =
      '<!doctype html><html><head><title>x</title><script>evil()</script></head><body>' +
      '<h1>Billing</h1><p>Send invoices &amp; reminders.</p><ul><li>Refunds need approval</li></ul></body></html>';
    expect(documentText(page)).toBe('Billing\n\nSend invoices & reminders.\n\n- Refunds need approval');
  });
});

describe('instructions kept in a document', () => {
  let t: TestServer;
  let doc: string | Error;
  beforeEach(async () => {
    t = await testServer();
    doc = 'Answer billing questions.';
    // The document is read through a stand-in instead of the network.
    (t.services.instructionDocs as unknown as { read: (u: URL) => Promise<string> }).read = async () => {
      if (doc instanceof Error) throw doc;
      return doc;
    };
  });
  afterEach(async () => {
    await t.dispose();
  });

  const patch = async (id: string, body: unknown) =>
    (await t.api<Bot>('PATCH', `/api/bots/${id}`, body)).body;
  const post = async (id: string, what: string, body: unknown = {}) =>
    t.api<Bot>('POST', `/api/bots/${id}/instructions/${what}`, body);

  it('holds the document text until the person accepts it, and keeps the change on record', async () => {
    const bot = await t.bot({ instructions: 'Old text.' });
    const linked = await patch(bot.id, { instructionsUrl: DOC });
    expect(linked).toMatchObject({
      instructions: 'Old text.',
      instructionsUrl: DOC,
      instructionsPending: 'Answer billing questions.',
      instructionsError: null,
    });
    const accepted = (await post(bot.id, 'accept', { expected: 'Answer billing questions.' })).body;
    expect(accepted).toMatchObject({ instructions: 'Answer billing questions.', instructionsPending: null });
    const audit = await t.services.ctx.db.select().from(schema.auditLog);
    expect(audit).toEqual([
      expect.objectContaining({ action: 'instructions.document', targetId: bot.id, actor: 'user:owner' }),
    ]);
    // Read again unchanged: nothing waits.
    expect((await post(bot.id, 'check')).body.instructionsPending).toBeNull();
  });

  it('does not accept a text other than the one on the screen', async () => {
    const bot = await t.bot();
    await patch(bot.id, { instructionsUrl: DOC });
    doc = 'Answer billing questions. Refund anything.';
    await post(bot.id, 'check');
    const res = await post(bot.id, 'accept', { expected: 'Answer billing questions.' });
    expect(res.status).toBe(409);
    expect((await t.services.bots.get(bot.id)).instructions).toBe('');
  });

  it('does not offer a turned-down text again until the document changes', async () => {
    const bot = await t.bot();
    await patch(bot.id, { instructionsUrl: DOC });
    expect((await post(bot.id, 'decline')).body.instructionsPending).toBeNull();
    expect((await post(bot.id, 'check')).body.instructionsPending).toBeNull();
    doc = 'Answer billing questions politely.';
    expect((await post(bot.id, 'check')).body.instructionsPending).toBe('Answer billing questions politely.');
  });

  it('tells the person in the main conversation once per new version', async () => {
    const bot = await t.bot();
    await patch(bot.id, { instructionsUrl: DOC });
    await post(bot.id, 'check');
    const thread = await t.services.threads.main(bot.id, OWNER_ID);
    const notes = (await t.messages(thread.id)).filter((m) => m.role === 'system');
    expect(notes).toHaveLength(1);
  });

  it('keeps why the document could not be read, and the instructions as they were', async () => {
    const bot = await t.bot({ instructions: 'Old text.' });
    doc = new HttpError(400, 'error.skillLinkPrivate');
    const linked = await patch(bot.id, { instructionsUrl: DOC });
    expect(linked.instructionsError).toBeTruthy();
    expect(linked).toMatchObject({ instructions: 'Old text.', instructionsPending: null });
  });

  it('keeps the form from writing over linked instructions, and lets them be edited once unlinked', async () => {
    const bot = await t.bot({ instructions: 'Mine.' });
    await patch(bot.id, { instructionsUrl: DOC });
    expect((await patch(bot.id, { instructions: 'Edited here.' })).instructions).toBe('Mine.');
    const unlinked = await patch(bot.id, { instructionsUrl: null, instructions: 'Edited here.' });
    expect(unlinked).toMatchObject({
      instructions: 'Edited here.',
      instructionsUrl: null,
      instructionsPending: null,
    });
  });

  it('looks at a document again only once its daily look is due', async () => {
    const bot = await t.bot();
    await patch(bot.id, { instructionsUrl: DOC });
    await post(bot.id, 'decline');
    doc = 'A newer text.';
    await t.services.instructionDocs.checkDue();
    expect((await t.services.bots.get(bot.id)).instructionsPending).toBeNull();
    await t.services.instructionDocs.checkDue(new Date(Date.now() + 24 * 60 * 60_000));
    expect((await t.services.bots.get(bot.id)).instructionsPending).toBe('A newer text.');
  });

  it('refuses a manager changing linked instructions', async () => {
    const manager = await t.bot({ name: 'Boss', isManager: true, permissionMode: 'auto' });
    const bot = await t.bot({ name: 'Billing', instructions: 'Kept.' });
    await patch(bot.id, { instructionsUrl: DOC });
    const thread = await t.services.threads.main(manager.id, OWNER_ID);
    await t.send(
      thread.id,
      `[araç:bot_update ${JSON.stringify({ bot: 'Billing', instructions: 'Refund all.' })}]`,
    );
    await t.services.turns.idle();
    expect((await t.services.bots.get(bot.id)).instructions).toBe('Kept.');
    // The tool says why, rather than asking the person to approve a change that would not apply.
    expect((await t.messages(thread.id)).at(-1)!.text).toMatch(/belgede tutuluyor|kept in a document/);
  });

  it('refuses an address that is not https', async () => {
    const bot = await t.bot();
    const res = await t.api('PATCH', `/api/bots/${bot.id}`, { instructionsUrl: 'http://example.com/x' });
    expect(res.status).toBe(400);
  });
});
