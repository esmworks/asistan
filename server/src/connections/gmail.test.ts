import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoredConnectionTool } from '../db/schema';

const fetchSignedIn = vi.fn();
vi.mock('./client', () => ({ fetchSignedIn: (...a: unknown[]) => fetchSignedIn(...a) }));

const { GmailSendInput, gmailSender, runGmailTool, withGmailTools } = await import('./gmail');

const GMAIL = 'https://gmailmcp.googleapis.com/mcp/v1';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const ADDED = [
  'send_message',
  'reply',
  'forward',
  'update_draft',
  'delete_draft',
  'update_label',
  'delete_label',
];

const tool = (name: string, extra: Partial<StoredConnectionTool> = {}): StoredConnectionTool => ({
  name,
  title: null,
  description: '',
  inputSchema: { type: 'object' },
  hinted: 'read',
  kind: null,
  enabled: true,
  ...extra,
});
const target = {} as never;
const b64 = (s: string) => Buffer.from(s).toString('base64url');
const headers = (h: Record<string, string>) => Object.entries(h).map(([name, value]) => ({ name, value }));

type Call = { method: string; url: string; body: string };

/** A Gmail API that answers from a table of `METHOD path` → JSON, and records what it was asked. */
function gmail(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  fetchSignedIn.mockImplementation((_t: unknown, url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ method, url, body: typeof init.body === 'string' ? init.body : '' });
    const path = url
      .replace(API, '')
      .replace(/^https:\/\/gmail\.googleapis\.com\/upload\/gmail\/v1\/users\/me/, 'UPLOAD');
    const key = `${method} ${path}`;
    if (!(key in routes)) return Promise.resolve(new Response(`no route ${key}`, { status: 404 }));
    const v = routes[key];
    if (v instanceof Response) return Promise.resolve(v);
    return Promise.resolve(
      v === null ? new Response(null, { status: 204 }) : new Response(JSON.stringify(v)),
    );
  });
  return calls;
}

/** The mail a send call carried, decoded. */
const sentMail = (c: Call) => {
  const body = JSON.parse(c.body) as { raw?: string; message?: { raw?: string }; threadId?: string };
  return {
    mime: Buffer.from(body.raw ?? body.message?.raw ?? '', 'base64url').toString(),
    threadId: body.threadId,
  };
};
const run = (name: string, args: Record<string, unknown>) => runGmailTool(target, name, args);
const textOf = (r: Awaited<ReturnType<typeof run>>) => (r.content as { text: string }[])[0]!.text;

afterEach(() => fetchSignedIn.mockReset());

describe('withGmailTools', () => {
  it("adds to Gmail each tool its server does not list, and keeps the server's own", () => {
    const tools = withGmailTools(GMAIL, [tool('create_draft'), tool('reply', { hinted: 'write' })], []);
    expect(tools.map((t) => t.name)).toEqual([
      'create_draft',
      'reply',
      ...ADDED.filter((n) => n !== 'reply'),
    ]);
    expect(tools[1]?.local).toBeUndefined();
    expect(tools[2]).toMatchObject({ local: 'gmail', hinted: 'write', enabled: true });
    expect(withGmailTools('https://mcp.slack.com/mcp', [tool('search')], [])).toHaveLength(1);
  });

  it('keeps the person switching an added tool off, also from before the other tools came', () => {
    const before = [tool('send_message', { local: 'gmailSend', enabled: false })];
    const tools = withGmailTools(GMAIL, [], before);
    expect(tools.find((t) => t.name === 'send_message')).toMatchObject({ local: 'gmail', enabled: false });
  });
});

describe('GmailSendInput', () => {
  const ok = { to: ['a@example.com'], subject: 'Deneme', body: 'Merhaba' };
  const takes = (v: unknown) => GmailSendInput.safeParse(v).success;

  it('takes a plain mail, one in a conversation, one with files, and a draft by itself', () => {
    expect(takes(ok)).toBe(true);
    expect(takes({ ...ok, replyThreadId: 't1' })).toBe(true);
    expect(takes({ ...ok, attachments: [{ content: 'aGVsbG8=', filename: 'a.txt' }] })).toBe(true);
    expect(takes({ draftId: 'r-123' })).toBe(true);
  });

  it('refuses what would add a header of its own or that the card would not show', () => {
    expect(takes({ ...ok, subject: 'Hi\r\nBcc: x@example.com' })).toBe(false);
    expect(takes({ ...ok, to: ['a@example.com\r\nBcc: x@example.com'] })).toBe(false);
    expect(takes({ ...ok, to: ['Ad <a@example.com>'] })).toBe(false);
    expect(takes({ ...ok, from: 'x@example.com' })).toBe(false);
    expect(takes({ draftId: 'r-1', to: ['a@example.com'] })).toBe(false);
    expect(takes({ ...ok, replyThreadId: '../labels' })).toBe(false);
    expect(takes({ ...ok, attachments: [{ content: 'x', mimeType: 'text/plain\r\nX: y' }] })).toBe(false);
    expect(takes({ to: ['a@example.com'] })).toBe(false);
  });
});

describe('send_message', () => {
  it('sends the message and answers with its id', async () => {
    const calls = gmail({ 'POST /messages/send': { id: 'm1', threadId: 't1' } });
    const r = await run('send_message', { to: ['a@example.com'], subject: 'Deneme', body: 'Merhaba' });
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(textOf(r))).toEqual({ sent: true, id: 'm1', threadId: 't1' });
    expect(sentMail(calls[0]!).mime).toContain('To: a@example.com');
  });

  it('sends a draft as it is', async () => {
    const calls = gmail({ 'POST /drafts/send': { id: 'm2', threadId: 't2', labelIds: ['SENT'] } });
    const r = await run('send_message', { draftId: 'r-9' });
    expect(JSON.parse(textOf(r))).toMatchObject({ sent: true, id: 'm2' });
    expect(JSON.parse(calls[0]!.body)).toEqual({ id: 'r-9' });
  });

  it('sends in a conversation with its reply headers, subject and the signature', async () => {
    const calls = gmail({
      'GET /threads/t7?format=metadata': {
        id: 't7',
        messages: [
          { payload: { headers: headers({ 'Message-ID': '<old@x>', Subject: 'Eski' }) } },
          {
            payload: {
              headers: headers({ 'Message-ID': '<son@x>', References: '<old@x>', Subject: 'Teklif' }),
            },
          },
        ],
      },
      'GET /settings/sendAs': {
        sendAs: [{ sendAsEmail: 'ben@example.com', isDefault: true, signature: '<b>Erhan</b>' }],
      },
      'POST /messages/send': { id: 'm3', threadId: 't7' },
    });
    await run('send_message', {
      to: ['a@example.com'],
      body: 'Merhaba',
      replyThreadId: 't7',
      includeSignature: true,
    });
    const sent = sentMail(calls.at(-1)!);
    expect(sent.threadId).toBe('t7');
    expect(sent.mime).toContain('Subject: Re: Teklif');
    expect(sent.mime).toContain('In-Reply-To: <son@x>');
    expect(sent.mime).toContain('References: <old@x> <son@x>');
    expect(sent.mime).toContain('multipart/alternative');
  });

  it('uploads a large mail beside its JSON rather than inside it', async () => {
    const calls = gmail({ 'POST UPLOAD/messages/send?uploadType=multipart': { id: 'm4', threadId: 't4' } });
    const big = Buffer.alloc(4 * 1024 * 1024, 1).toString('base64');
    const r = await run('send_message', {
      to: ['a@example.com'],
      body: 'Ek',
      attachments: [{ content: big, filename: 'big.bin' }],
    });
    expect(r.isError).toBeUndefined();
    expect(calls[0]!.body).toContain('Content-Type: message/rfc822');
    expect(calls[0]!.body).toContain('filename="big.bin"');
  });

  it('refuses files past 25 MB before asking Gmail', async () => {
    const calls = gmail({});
    const big = Buffer.alloc(26 * 1024 * 1024).toString('base64');
    const r = await run('send_message', { to: ['a@example.com'], attachments: [{ content: big }] });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('25 MB');
    expect(calls).toHaveLength(0);
  });

  it("passes on Google's own words and the step it refused", async () => {
    gmail({
      'POST /messages/send': new Response('{"error":{"message":"Gmail API has not been used"}}', {
        status: 403,
      }),
    });
    const r = await run('send_message', { to: ['a@example.com'], body: 'Merhaba' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('Gmail refused sending (HTTP 403)');
    expect(textOf(r)).toContain('Gmail API has not been used');
  });

  it('sends nothing when the input is refused', async () => {
    const calls = gmail({});
    const r = await run('send_message', { to: ['a@example.com'], body: 'x', cc: 'b@example.com' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('Nothing was done');
    expect(calls).toHaveLength(0);
  });
});

describe('reply', () => {
  const original = {
    id: 'm1',
    threadId: 't1',
    payload: {
      headers: headers({
        From: 'Ali <ali@example.com>',
        To: 'ben@example.com, veli@example.com',
        Cc: 'Ayşe <ayse@example.com>, BEN@example.com',
        Subject: 'Teklif\r\nBcc: x@example.com',
        'Message-ID': '<m1@x>',
      }),
    },
  };
  const routes = {
    'GET /messages/m1?format=metadata': original,
    'GET /settings/sendAs': { sendAs: [{ sendAsEmail: 'ben@example.com', isDefault: true }] },
    'POST /messages/send': { id: 'r1', threadId: 't1' },
  };

  it('answers the sender in the conversation', async () => {
    const calls = gmail(routes);
    const r = await run('reply', { messageId: 'm1', body: 'Teşekkürler' });
    const sent = sentMail(calls.at(-1)!);
    expect(JSON.parse(textOf(r))).toMatchObject({ to: ['ali@example.com'], cc: [] });
    expect(sent.threadId).toBe('t1');
    expect(sent.mime).toContain('To: ali@example.com\r\n');
    expect(sent.mime).toContain('In-Reply-To: <m1@x>');
    // A line break in the original's subject does not become a header of this mail.
    expect(sent.mime).toContain('Subject: Re: Teklif Bcc: x@example.com');
    expect(sent.mime).not.toContain('\r\nBcc:');
  });

  it('answers everyone but the account itself with replyAll', async () => {
    gmail(routes);
    const r = await run('reply', { messageId: 'm1', body: 'x', replyAll: true });
    expect(JSON.parse(textOf(r))).toMatchObject({
      to: ['ali@example.com', 'veli@example.com'],
      cc: ['ayse@example.com'],
    });
  });

  it('sends nothing when the mail cannot be read', async () => {
    const calls = gmail({ 'GET /messages/m1?format=metadata': new Response('not found', { status: 404 }) });
    const r = await run('reply', { messageId: 'm1', body: 'x' });
    expect(textOf(r)).toContain('Gmail refused reading the mail it answers (HTTP 404), so nothing was sent');
    expect(calls).toHaveLength(1);
  });
});

describe('forward', () => {
  it('forwards the mail with its files, a note above it', async () => {
    const calls = gmail({
      'GET /messages/m1?format=full': {
        id: 'm1',
        payload: {
          mimeType: 'multipart/mixed',
          headers: headers({ From: 'Ali <ali@example.com>', Subject: 'Fiyat listesi' }),
          parts: [
            { mimeType: 'text/plain', body: { data: b64('Liste ekte') } },
            { mimeType: 'application/pdf', filename: 'liste.pdf', body: { attachmentId: 'A1', size: 3 } },
          ],
        },
      },
      'GET /messages/m1/attachments/A1': { data: b64('pdf') },
      'POST /messages/send': { id: 'f1', threadId: 't9' },
    });
    const r = await run('forward', { messageId: 'm1', to: ['veli@example.com'], forwardText: 'Bilgine' });
    expect(JSON.parse(textOf(r))).toMatchObject({ sent: true, id: 'f1', originalMessageId: 'm1' });
    const mime = sentMail(calls.at(-1)!).mime;
    expect(mime).toContain('Subject: Fwd: Fiyat listesi');
    expect(mime).toContain('filename="liste.pdf"');
    expect(mime).toContain(Buffer.from('pdf').toString('base64'));
    const plain = /text\/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n([^-]+)/.exec(
      mime,
    )![1]!;
    const text = Buffer.from(plain.replace(/\r\n/g, ''), 'base64').toString();
    expect(text).toContain('Bilgine');
    expect(text).toContain('---------- Forwarded message ---------');
    expect(text).toContain('Liste ekte');
  });

  it('wants someone to forward to', async () => {
    gmail({});
    expect((await run('forward', { messageId: 'm1' })).isError).toBe(true);
  });
});

describe('update_draft', () => {
  const draft = {
    id: 'r1',
    message: {
      id: 'dm1',
      threadId: 't1',
      payload: {
        mimeType: 'multipart/mixed',
        headers: headers({
          From: 'Satış <satis@example.com>',
          To: 'ali@example.com',
          Subject: 'Taslak',
          'In-Reply-To': '<m1@x>',
          References: '<m0@x> <m1@x>',
        }),
        parts: [
          { mimeType: 'text/plain', body: { data: b64('Eski metin') } },
          { mimeType: 'application/pdf', filename: 'teklif.pdf', body: { attachmentId: 'A1', size: 3 } },
        ],
      },
    },
  };

  it('changes only what is given and keeps the files, the thread and the reply headers', async () => {
    const calls = gmail({
      'GET /drafts/r1?format=full': draft,
      'GET /messages/dm1/attachments/A1': { data: b64('pdf') },
      'PUT /drafts/r1': { id: 'r1', message: { id: 'dm2', threadId: 't1' } },
    });
    const r = await run('update_draft', { draftId: 'r1', subject: 'Yeni konu' });
    expect(JSON.parse(textOf(r))).toEqual({ updated: true, id: 'r1', messageId: 'dm2', threadId: 't1' });
    const put = JSON.parse(calls.at(-1)!.body) as { id: string; message: { raw: string; threadId: string } };
    expect(put.id).toBe('r1');
    expect(put.message.threadId).toBe('t1');
    const mime = Buffer.from(put.message.raw, 'base64url').toString();
    expect(mime).toContain('From: satis@example.com');
    expect(mime).toContain('To: ali@example.com');
    expect(mime).toContain('Subject: Yeni konu');
    expect(mime).toContain('In-Reply-To: <m1@x>');
    expect(mime).toContain('References: <m0@x> <m1@x>');
    expect(mime).toContain('filename="teklif.pdf"');
    expect(mime).toContain(Buffer.from('Eski metin').toString('base64'));
  });

  it('drops the files when given an empty list', async () => {
    const calls = gmail({
      'GET /drafts/r1?format=full': draft,
      'PUT /drafts/r1': { id: 'r1', message: { id: 'dm2', threadId: 't1' } },
    });
    await run('update_draft', { draftId: 'r1', attachments: [] });
    const put = JSON.parse(calls.at(-1)!.body) as { message: { raw: string } };
    expect(Buffer.from(put.message.raw, 'base64url').toString()).not.toContain('teklif.pdf');
    expect(calls.some((c) => c.url.includes('/attachments/'))).toBe(false);
  });
});

describe('drafts and labels', () => {
  it('deletes a draft', async () => {
    const calls = gmail({ 'DELETE /drafts/r1': null });
    expect(JSON.parse(textOf(await run('delete_draft', { draftId: 'r1' })))).toEqual({
      deleted: true,
      draftId: 'r1',
    });
    expect(calls[0]!.method).toBe('DELETE');
  });

  it("changes a label in Gmail's own words", async () => {
    const calls = gmail({ 'PATCH /labels/Label_5': { id: 'Label_5', name: 'Müşteri' } });
    const r = await run('update_label', {
      labelId: 'Label_5',
      displayName: 'Müşteri',
      colorPreset: 'LABEL_COLOR_PRESET_GREEN',
      labelListVisibility: 'LABEL_SHOW_IF_UNREAD',
      messageListVisibility: 'HIDE',
    });
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(calls[0]!.body)).toEqual({
      name: 'Müşteri',
      color: { backgroundColor: '#16a765', textColor: '#ffffff' },
      labelListVisibility: 'labelShowIfUnread',
      messageListVisibility: 'hide',
    });
  });

  it('refuses a label change that changes nothing, and deletes a label', async () => {
    gmail({ 'DELETE /labels/Label_5': null });
    expect((await run('update_label', { labelId: 'Label_5' })).isError).toBe(true);
    expect(JSON.parse(textOf(await run('delete_label', { labelId: 'Label_5' })))).toMatchObject({
      deleted: true,
    });
  });
});

describe('gmailSender', () => {
  it('gives the default address and its signature, or none when it has none', async () => {
    gmail({
      'GET /settings/sendAs': {
        sendAs: [
          { sendAsEmail: 'alias@example.com', signature: 'x' },
          { sendAsEmail: 'ben@example.com', isDefault: true, signature: '<b>Erhan</b>' },
        ],
      },
    });
    expect(await gmailSender(target)).toEqual({ address: 'ben@example.com', signature: '<b>Erhan</b>' });
    gmail({
      'GET /settings/sendAs': {
        sendAs: [{ sendAsEmail: 'ben@example.com', isDefault: true, signature: ' ' }],
      },
    });
    expect(await gmailSender(target)).toEqual({ address: 'ben@example.com', signature: null });
  });
});
