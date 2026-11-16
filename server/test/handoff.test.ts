import { describe, expect, it } from 'vitest';
import { cutAt, truncate } from '../src/util';
import {
  HANDOFF_CHARS,
  HANDOFF_MESSAGE_CHARS,
  HANDOFF_MESSAGES,
  handoffPrompt,
  withinBudget,
} from '../src/runtime/prompt';

const msg = (role: string, text: string, author = role === 'user' ? 'user' : 'bot:b') => ({
  role,
  author,
  text,
});
const names = new Map([['bot:b', 'Kahya']]);

describe('geçmişi yeni oturuma devretme', () => {
  it('geçmiş yoksa istemi olduğu gibi bırakır', () => {
    expect(
      handoffPrompt({ messages: [msg('user', 'merhaba')], prompt: 'merhaba', names, locale: 'tr' }),
    ).toBe('merhaba');
  });

  it('kartları, hataları ve cevapsız son mesajları almaz', () => {
    const out = handoffPrompt({
      messages: [
        msg('user', 'soru'),
        msg('approval', 'kart', 'bot:b'),
        msg('assistant', 'cevap'),
        msg('error', 'hata', 'system'),
        msg('user', 'yeni'),
      ],
      prompt: 'yeni',
      names,
      locale: 'tr',
    });
    expect(out).toContain('Kullanıcı: soru\n\nKahya: cevap');
    expect(out).not.toContain('kart');
    expect(out).not.toContain('hata');
    expect(out.split('yeni')).toHaveLength(2);
  });

  it('uzun mesajı kısaltır, yalnızca son mesajları ve sınır kadarını alır', () => {
    const many = Array.from({ length: HANDOFF_MESSAGES + 10 }, (_, i) =>
      msg(i % 2 ? 'assistant' : 'user', `m${i} ` + 'x'.repeat(HANDOFF_MESSAGE_CHARS)),
    );
    const out = handoffPrompt({ messages: many, prompt: 'son', names, locale: 'en' });
    expect(out).not.toContain('m0 ');
    expect(out).toContain(`m${many.length - 1} `);
    expect(out).toContain('…');
    expect(out.length).toBeLessThan(HANDOFF_CHARS + 1_000);
    expect(out).toContain('<earlier-conversation>');
  });
});

describe('kısaltma', () => {
  it('emojiyi ortadan bölmez', () => {
    expect(cutAt('ab😀', 3)).toBe('ab');
    expect(truncate('selam 👋🏽 dünya', 8)).toBe('selam …');
    expect(cutAt('a❤️', 2)).toBe('a❤');
    expect(cutAt('kısa', 10)).toBe('kısa');
  });
});

describe('hafıza bütçesi', () => {
  it('sığmayanları en eskilerden bırakır ve sayısını verir', () => {
    const m = (content: string, day: number) => ({
      content,
      createdAt: `2026-11-${String(day).padStart(2, '0')}T00:00:00Z`,
    });
    const r = withinBudget([m('a'.repeat(10), 1), m('b'.repeat(10), 3)], [m('c'.repeat(10), 2)], 27);
    expect(r.user.map((x) => x.content[0])).toEqual(['b']);
    expect(r.bot.map((x) => x.content[0])).toEqual(['c']);
    expect(r.left).toBe(1);
  });

  it('eski ama yakında aranıp bulunan ya da düzeltilen not, kimsenin bakmadığı yeni notun önüne geçer', () => {
    const day = (d: number) => `2026-11-${String(d).padStart(2, '0')}T00:00:00.000Z`;
    const looked = { content: 'a'.repeat(10), createdAt: day(1), updatedAt: day(1), lastUsedAt: day(15) };
    const edited = { content: 'b'.repeat(10), createdAt: day(2), updatedAt: day(14), lastUsedAt: null };
    const fresh = { content: 'c'.repeat(10), createdAt: day(10), updatedAt: day(10), lastUsedAt: null };
    const r = withinBudget([looked, fresh], [edited], 27);
    expect(r.user).toEqual([looked]);
    expect(r.bot).toEqual([edited]);
    expect(r.left).toBe(1);
  });
});
