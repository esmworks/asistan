import { describe, expect, it } from 'vitest';
import { emailPreview } from './email-preview';

describe('emailPreview', () => {
  it('reads a new mail with its recipients, subject, text and signature', () => {
    const p = emailPreview('mcp__gmail__send_message', {
      to: ['a@example.com'],
      cc: ['b@example.com'],
      subject: 'Deneme',
      body: 'Merhaba',
      includeSignature: true,
      attachments: [{ filename: 'teklif.pdf', content: 'AAAA' }],
    });
    expect(p).toMatchObject({
      kind: 'send',
      to: ['a@example.com'],
      cc: ['b@example.com'],
      bcc: [],
      subject: 'Deneme',
      text: 'Merhaba',
      html: null,
      signature: true,
      attachments: ['teklif.pdf'],
      draftId: null,
    });
  });

  it('reads a reply and a forward by the mail they answer', () => {
    expect(
      emailPreview('mcp__gmail__reply', { messageId: 'm1', body: 'Tamam', replyAll: true }),
    ).toMatchObject({
      kind: 'reply',
      to: [],
      replyAll: true,
      text: 'Tamam',
    });
    expect(
      emailPreview('mcp__gmail__forward', {
        messageId: 'm1',
        to: ['c@example.com'],
        forwardText: 'Bilginize',
      }),
    ).toMatchObject({ kind: 'forward', to: ['c@example.com'], text: 'Bilginize' });
  });

  it('reads a draft sent as it is', () => {
    expect(emailPreview('mcp__gmail__send_message', { draftId: 'd1' })).toMatchObject({
      kind: 'send',
      draftId: 'd1',
      to: [],
    });
  });

  it('takes recipients written as one line or as address objects', () => {
    expect(emailPreview('mcp__mail__send_mail', { to: 'a@example.com, b@example.com' })?.to).toEqual([
      'a@example.com',
      'b@example.com',
    ]);
    expect(
      emailPreview('mcp__outlook__send_mail', {
        toRecipients: [{ emailAddress: { address: 'a@example.com' } }],
      })?.to,
    ).toEqual(['a@example.com']);
  });

  it('shows every recipient and attachment, and keeps the whole input with file contents left out', () => {
    const to = Array.from({ length: 80 }, (_, i) => `k${i}@example.com`);
    const p = emailPreview('mcp__gmail__send_message', {
      to,
      attachments: Array.from({ length: 30 }, (_, i) => ({ filename: `${i}.pdf`, content: 'A'.repeat(500) })),
      replyThreadId: 't1',
    });
    expect(p?.to).toHaveLength(80);
    expect(p?.attachments).toHaveLength(30);
    expect(p?.inThread).toBe(true);
    expect(p?.raw).toContain('"replyThreadId": "t1"');
    expect(p?.raw).toContain('… (500)');
    expect(p?.raw).not.toContain('AAAA');
  });

  it('leaves out calls that are not mail', () => {
    // A chat app's send_message names a space, not people with addresses.
    expect(emailPreview('mcp__googlechat__send_message', { space: 'spaces/1', text: 'Selam' })).toBeNull();
    expect(emailPreview('mcp__gmail__search_threads', { query: 'is:unread' })).toBeNull();
    expect(emailPreview('mcp__leafbot__send_message', { to: ['a@example.com'] })).toBeNull();
    expect(emailPreview('send_message', { to: ['a@example.com'] })).toBeNull();
    expect(emailPreview('mcp__gmail__reply', { body: 'Tamam' })).toBeNull();
  });
});
