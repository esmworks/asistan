import { describe, expect, it } from 'vitest';
import { createTranslator, type Memory, type MemoryHistoryLine } from '@yumakbot/shared';
import { en } from '@/i18n/en';
import { tr } from '@/i18n/tr';
import {
  foldText,
  historyText,
  historyWho,
  noteExpired,
  noteMatches,
  pinnedFirst,
  placeLabel,
  placeNoteGroups,
  untilDay,
  untilEndOfDay,
} from './memoryNotes';

const t = createTranslator({ tr, en }, 'tr');

const note = (over: Partial<Memory>): Memory => ({
  id: 'n',
  scope: 'room',
  botId: null,
  content: '',
  site: null,
  status: 'active',
  source: 'bot',
  lastUsedAt: null,
  useCount: 0,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
});

describe('not araması', () => {
  it('büyük küçük harf, aksan ve noktasız ı farkını yok sayar', () => {
    expect(foldText('SINIR İş')).toBe('sinir is');
    expect(noteMatches(note({ content: 'Sınır değeri 5' }), 'SINIR')).toBe(true);
    expect(noteMatches(note({ content: 'Sınır değeri 5' }), 'sinir degeri')).toBe(true);
    expect(noteMatches(note({ content: 'Sınır değeri 5' }), 'sinir 9')).toBe(false);
  });

  it('siteyi de arar; boş arama hepsini getirir', () => {
    const m = note({ content: 'giriş yapılmış', site: 'Example.com' });
    expect(noteMatches(m, 'example')).toBe(true);
    expect(noteMatches(m, '  ')).toBe(true);
  });
});

describe('sabit notlar', () => {
  it('sabitleri öne alır, sırayı bozmaz', () => {
    const list = [
      note({ id: 'a' }),
      note({ id: 'b', pinned: true }),
      note({ id: 'c' }),
      note({ id: 'd', pinned: true }),
    ];
    expect(pinnedFirst(list).map((m) => m.id)).toEqual(['b', 'd', 'a', 'c']);
  });
});

describe('yer adı', () => {
  it('kanalı ve odayı adlandırır', () => {
    expect(placeLabel('slack:C1', t)).toBe('Slack kanalı C1');
    expect(placeLabel('discord:99', t)).toBe('Discord kanalı 99');
    expect(placeLabel('room:r1', t)).toBe('Oda');
    expect(placeLabel('room:r1', t, [{ id: 'r1', title: 'Plan' }])).toBe('Oda: Plan');
    expect(placeLabel(null, t)).toBe('Bilinmeyen yer');
  });

  it('yer notlarını yere göre gruplar', () => {
    const groups = placeNoteGroups(
      [
        note({ id: '1', place: 'slack:C1' }),
        note({ id: '2', place: 'room:r1', pinned: true }),
        note({ id: '3', place: 'slack:C1', pinned: true }),
        note({ id: '4', scope: 'user' }),
      ],
      t,
    );
    expect(groups.map((g) => g.place)).toEqual(['room:r1', 'slack:C1']);
    expect(groups[1]!.notes.map((m) => m.id)).toEqual(['3', '1']);
  });
});

describe('geçmiş satırı', () => {
  const line = (over: Partial<MemoryHistoryLine>): MemoryHistoryLine => ({
    id: 'h',
    actor: 'user:u1',
    action: 'create',
    targetId: 'n',
    before: null,
    after: 'yeni',
    owner: 'user:u1',
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  });

  it('kimin yaptığını söyler', () => {
    const bots = [{ id: 'b1', name: 'Asya' }];
    expect(historyWho({ actor: 'user:u1', owner: null }, 'u1', bots, t)).toBe('Siz');
    expect(historyWho({ actor: 'user:u2', owner: null }, 'u1', bots, t)).toBe('Bir kişi');
    expect(historyWho({ actor: 'bot:b1', owner: null }, 'u1', bots, t)).toBe('Asya');
    // A note added by hand before the history named its writer: the asker's own notes are theirs.
    expect(historyWho({ actor: 'user', owner: 'user:u1' }, 'u1', bots, t)).toBe('Siz');
    expect(historyWho({ actor: 'user', owner: 'user:u2' }, 'u1', bots, t)).toBe('Bir kişi');
  });

  it('metni varsa gösterir, silinen notta saklanmadığını söyler', () => {
    expect(historyText(line({}), t)).toBe('Eklendi · yeni');
    expect(historyText(line({ action: 'update', before: 'eski', after: 'yeni' }), t)).toBe(
      'Değiştirildi · yeni',
    );
    expect(historyText(line({ action: 'delete', after: null }), t)).toBe('Silindi · metin saklanmıyor');
    expect(historyText(line({ action: 'pin', after: null }), t)).toBe('Sabitlendi');
  });
});

describe('notes that are true until a date', () => {
  it('a note is expired once its time has passed, and a note with no date never is', () => {
    const now = new Date('2026-11-20T12:00:00Z');
    expect(noteExpired({ validUntil: '2026-11-20T11:59:00Z' }, now)).toBe(true);
    expect(noteExpired({ validUntil: '2026-11-20T12:01:00Z' }, now)).toBe(false);
    expect(noteExpired({ validUntil: null }, now)).toBe(false);
    expect(noteExpired({}, now)).toBe(false);
  });

  it('the date field reads the day on the person own calendar and saves the end of it', () => {
    expect(untilDay(untilEndOfDay('2026-11-27'))).toBe('2026-11-27');
    const end = new Date(untilEndOfDay('2026-11-27'));
    expect([end.getHours(), end.getMinutes()]).toEqual([23, 59]);
  });
});
