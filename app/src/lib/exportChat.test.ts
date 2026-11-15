import type { Message } from '@yumakbot/shared';
import { describe, expect, it } from 'vitest';
import { conversationMarkdown, exportFileName } from './exportChat';

const m = (role: Message['role'], text: string, props: Record<string, unknown> = {}): Message => ({
  id: text,
  threadId: 't',
  role,
  author: role === 'user' ? 'user' : 'bot:b',
  text,
  props,
  clientId: null,
  turnId: null,
  createdAt: '2026-11-14T10:00:00.000Z',
});

describe('sohbeti dışa aktar', () => {
  it('kişinin ve botun mesajlarını yazar, kartları atlar, dosyaları adıyla listeler', () => {
    const md = conversationMarkdown(
      'Kira',
      [
        m('user', 'Merhaba'),
        m('approval', 'onay'),
        m('assistant', '**Tamam**'),
        m('user', '', { files: [{ name: 'a.pdf' }] }),
      ],
      { author: (x) => (x.role === 'user' ? 'Ben' : 'Katip'), time: () => '10:00' },
    );
    expect(md).toBe(
      '# Kira\n\n## Ben · 10:00\n\nMerhaba\n\n## Katip · 10:00\n\n**Tamam**\n\n## Ben · 10:00\n\n- 📎 a.pdf\n',
    );
  });

  it('dosya adından yasak karakterleri atar', () => {
    expect(exportFileName('Rapor: 3/4 "son"', '2026-11-14')).toBe('Rapor 3 4 son 2026-11-14.md');
    expect(exportFileName('   ', '2026-11-14')).toBe('conversation 2026-11-14.md');
  });
});
