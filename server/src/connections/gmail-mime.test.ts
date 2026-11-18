import { describe, expect, it } from 'vitest';
import {
  addressesIn,
  forwardHeader,
  messageIds,
  mimeMessage,
  readParts,
  replySubject,
  withSignature,
} from './gmail-mime';

const decode = (b64: string) => Buffer.from(b64.replace(/\r\n/g, ''), 'base64').toString();

describe('mimeMessage', () => {
  it('encodes a Turkish subject and body', () => {
    const m = mimeMessage(
      { to: ['a@example.com'], subject: 'Teklif güncellemesi', text: 'Çalışma şöyle' },
      'b',
    );
    expect(m).toContain(`Subject: =?UTF-8?B?${Buffer.from('Teklif güncellemesi').toString('base64')}?=`);
    expect(m).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(decode(m.split('\r\n\r\n')[1]!)).toBe('Çalışma şöyle');
  });

  it('carries both a plain and an HTML body as alternatives', () => {
    const m = mimeMessage(
      { to: ['a@example.com'], cc: ['b@example.com'], text: 'Merhaba', html: '<p>Merhaba</p>' },
      'sinir',
    );
    expect(m).toContain('Cc: b@example.com');
    expect(m).toContain('Content-Type: multipart/alternative; boundary="sinir-a"');
    expect(m).toContain('Content-Type: text/html; charset="UTF-8"');
    expect(m.trimEnd().endsWith('--sinir-a--')).toBe(true);
  });

  it('puts pictures beside the HTML and files after it, each named safely', () => {
    const m = mimeMessage(
      {
        to: ['a@example.com'],
        html: '<img src="cid:att1">',
        files: [
          { filename: 'Fatura Ekim.pdf', mimeType: 'application/pdf', data: Buffer.from('pdf') },
          { filename: 'logo.png', mimeType: 'image/png', data: Buffer.from('png'), contentId: 'att1' },
          {
            filename: 'çizim "son".txt',
            mimeType: 'text/plain\r\nBcc: x@example.com',
            data: Buffer.from('x'),
          },
          { mimeType: 'application/zip', data: Buffer.from('z') },
          { filename: 'Çizim (1).pdf', mimeType: 'application/pdf', data: Buffer.from('p') },
        ],
      },
      's',
    );
    expect(m).toContain('Content-Type: multipart/mixed; boundary="s-m"');
    expect(m).toContain('Content-Type: multipart/related; boundary="s-r"');
    expect(m.indexOf('multipart/mixed')).toBeLessThan(m.indexOf('multipart/related'));
    expect(m).toContain('Content-Disposition: attachment; filename="Fatura Ekim.pdf"');
    expect(m).toContain('Content-Disposition: inline; filename="logo.png"');
    expect(m).toContain('Content-ID: <att1>');
    expect(m).toContain(`filename*=UTF-8''${encodeURIComponent('çizim "son".txt')}`);
    expect(m).toContain(`filename*=UTF-8''%C3%87izim%20%281%29.pdf`);
    // A media type with a line break in it goes as the generic one; nothing reaches the headers.
    expect(m).not.toContain('Bcc: x@example.com');
    expect(m).toContain('Content-Type: application/octet-stream');
    // A file given with no name has no name parameter.
    expect(m).toContain('Content-Type: application/zip\r\n');
    expect(m).toContain('Content-Disposition: attachment\r\n');
  });

  it('threads a reply and leaves out an empty To', () => {
    const m = mimeMessage(
      { to: [], bcc: ['b@example.com'], text: 'x', inReplyTo: '<1@x>', references: '<0@x> <1@x>' },
      'b',
    );
    expect(m).not.toMatch(/^To:/m);
    expect(m).toContain('In-Reply-To: <1@x>');
    expect(m).toContain('References: <0@x> <1@x>');
  });
});

describe('reading mail', () => {
  it('takes only message ids from a header someone else wrote', () => {
    expect(messageIds('<a@x.com>\r\nBcc: evil@example.com <b@y.com>')).toEqual(['<a@x.com>', '<b@y.com>']);
  });

  it('takes the addresses from a header', () => {
    expect(addressesIn('Ayşe Yılmaz <ayse@example.com>, "B, C" <b@example.com>, d@example.com')).toEqual([
      'ayse@example.com',
      'b@example.com',
      'd@example.com',
    ]);
  });

  it('adds Re: once', () => {
    expect(replySubject('Teklif')).toBe('Re: Teklif');
    expect(replySubject('RE: Teklif')).toBe('RE: Teklif');
  });

  it('reads a message body and its files', () => {
    const b64 = (s: string) => Buffer.from(s).toString('base64url');
    const read = readParts({
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', body: { data: b64('Merhaba') } },
            { mimeType: 'text/html', body: { data: b64('<p>Merhaba</p>') } },
          ],
        },
        {
          mimeType: 'image/png',
          filename: 'logo.png',
          headers: [{ name: 'Content-ID', value: '<logo@x>' }],
          body: { attachmentId: 'A1', size: 10 },
        },
        { mimeType: 'bad type', filename: 'a\r\nb.txt', body: { data: b64('x'), size: 1 } },
        {
          mimeType: 'image/gif',
          headers: [{ name: 'Content-ID', value: '<spacer>' }],
          body: { attachmentId: 'A2', size: 4 },
        },
        {
          mimeType: 'message/rfc822',
          filename: 'eski.eml',
          body: { attachmentId: 'A3', size: 9 },
          parts: [
            { mimeType: 'text/plain', body: { data: b64('İçteki metin') } },
            { mimeType: 'application/pdf', filename: 'iç.pdf', body: { attachmentId: 'A4', size: 2 } },
          ],
        },
      ],
    });
    expect(read.text).toBe('Merhaba');
    expect(read.html).toBe('<p>Merhaba</p>');
    expect(read.files).toEqual([
      { filename: 'logo.png', mimeType: 'image/png', size: 10, attachmentId: 'A1', contentId: 'logo@x' },
      { filename: 'a  b.txt', mimeType: 'application/octet-stream', size: 1, data: b64('x') },
      // A picture the HTML shows by its id, with no name, is a file too.
      { mimeType: 'image/gif', size: 4, attachmentId: 'A2', contentId: 'spacer' },
      // A forwarded mail is one file; its own text and files stay inside it.
      { filename: 'eski.eml', mimeType: 'message/rfc822', size: 9, attachmentId: 'A3' },
    ]);
  });

  it('heads a forwarded mail with its sender and subject, escaped in HTML', () => {
    const h = forwardHeader({
      headers: [
        { name: 'From', value: 'Ali <ali@example.com>' },
        { name: 'Subject', value: 'Teklif' },
      ],
    });
    expect(h.text).toContain('From: Ali <ali@example.com>');
    expect(h.html).toContain('From: Ali &lt;ali@example.com&gt;');
  });

  it('adds the signature to both versions of the body', () => {
    const b = withSignature({ text: 'Merhaba' }, '<b>Erhan</b><br>Satış');
    expect(b.text).toBe('Merhaba\n\n-- \nErhan\nSatış');
    expect(b.html).toContain('Merhaba<br><br><div class="gmail_signature"><b>Erhan</b><br>Satış</div>');
    expect(withSignature({ text: 'x' }, '  ')).toEqual({ text: 'x' });
  });
});
