import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoredConnectionTool } from '../db/schema';

const fetchSignedIn = vi.fn();
vi.mock('./client', () => ({ fetchSignedIn: (...a: unknown[]) => fetchSignedIn(...a) }));

const { GmailSendInput, mimeMessage, sendGmail, withGmailSend } = await import('./gmail');

const GMAIL = 'https://gmailmcp.googleapis.com/mcp/v1';
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

afterEach(() => fetchSignedIn.mockReset());

describe('withGmailSend', () => {
  it('adds the sending tool to Gmail when its server lists none', () => {
    const tools = withGmailSend(GMAIL, [tool('create_draft')], []);
    expect(tools.map((t) => t.name)).toEqual(['create_draft', 'send_message']);
    expect(tools[1]).toMatchObject({ local: 'gmailSend', hinted: 'write', enabled: true });
  });

  it("keeps the server's own tool when it lists one, and adds nothing to other services", () => {
    const own = [tool('send_message', { hinted: 'write' })];
    expect(withGmailSend(GMAIL, own, [])).toEqual(own);
    expect(withGmailSend('https://mcp.slack.com/mcp', [tool('search')], [])).toHaveLength(1);
  });

  it('keeps the person switching the added tool off', () => {
    const before = [tool('send_message', { local: 'gmailSend', enabled: false })];
    expect(withGmailSend(GMAIL, [], before)[0]?.enabled).toBe(false);
  });
});

describe('GmailSendInput', () => {
  const ok = { to: ['a@example.com'], subject: 'Deneme', body: 'Merhaba' };

  it('takes a plain mail', () => {
    expect(GmailSendInput.safeParse(ok).success).toBe(true);
  });

  it('refuses what would add a header of its own or that the card would not show', () => {
    expect(GmailSendInput.safeParse({ ...ok, subject: 'Hi\r\nBcc: x@example.com' }).success).toBe(false);
    expect(GmailSendInput.safeParse({ ...ok, to: ['a@example.com\r\nBcc: x@example.com'] }).success).toBe(
      false,
    );
    expect(GmailSendInput.safeParse({ ...ok, to: ['Ad <a@example.com>'] }).success).toBe(false);
    expect(GmailSendInput.safeParse({ ...ok, replyThreadId: 't1' }).success).toBe(false);
    expect(GmailSendInput.safeParse({ to: ['a@example.com'] }).success).toBe(false);
  });
});

describe('mimeMessage', () => {
  it('encodes a Turkish subject and body', () => {
    const m = mimeMessage(
      { to: ['a@example.com'], subject: 'Teklif güncellemesi', body: 'Çalışma şöyle' },
      'b',
    );
    expect(m).toContain(`Subject: =?UTF-8?B?${Buffer.from('Teklif güncellemesi').toString('base64')}?=`);
    expect(m).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(Buffer.from(m.split('\r\n\r\n')[1]!.replace(/\r\n/g, ''), 'base64').toString()).toBe(
      'Çalışma şöyle',
    );
  });

  it('carries both a plain and an HTML body as alternatives', () => {
    const m = mimeMessage(
      { to: ['a@example.com'], cc: ['b@example.com'], body: 'Merhaba', htmlBody: '<p>Merhaba</p>' },
      'sinir',
    );
    expect(m).toContain('Cc: b@example.com');
    expect(m).toContain('Content-Type: multipart/alternative; boundary="sinir"');
    expect(m).toContain('Content-Type: text/html; charset="UTF-8"');
    expect(m.trimEnd().endsWith('--sinir--')).toBe(true);
  });
});

describe('sendGmail', () => {
  it('sends the message and answers with its id', async () => {
    fetchSignedIn.mockResolvedValue(
      new Response(JSON.stringify({ id: 'm1', threadId: 't1' }), { status: 200 }),
    );
    const r = await sendGmail(target, { to: ['a@example.com'], subject: 'Deneme', body: 'Merhaba' });
    expect(r.isError).toBeUndefined();
    expect(r.content).toEqual([
      { type: 'text', text: JSON.stringify({ sent: true, id: 'm1', threadId: 't1' }) },
    ]);
    const [, url, init] = fetchSignedIn.mock.calls[0]! as [unknown, string, RequestInit];
    expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    const raw = JSON.parse(String(init.body)) as { raw: string };
    expect(Buffer.from(raw.raw, 'base64url').toString()).toContain('To: a@example.com');
  });

  it("passes on Google's own words when it refuses", async () => {
    fetchSignedIn.mockResolvedValue(
      new Response('{"error":{"message":"Gmail API has not been used"}}', { status: 403 }),
    );
    const r = await sendGmail(target, { to: ['a@example.com'], body: 'Merhaba' });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain('HTTP 403');
    expect(JSON.stringify(r.content)).toContain('Gmail API has not been used');
  });

  it('sends nothing when the input is refused', async () => {
    const r = await sendGmail(target, { to: ['a@example.com'], body: 'x', attachments: [] });
    expect(r.isError).toBe(true);
    expect(fetchSignedIn).not.toHaveBeenCalled();
  });
});
