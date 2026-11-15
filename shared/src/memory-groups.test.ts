import { describe, expect, it } from 'vitest';
import { botNoteGroups } from './memory-groups';
import type { Memory } from './schemas';

const note = (id: string, scope: 'bot' | 'user', botId: string | null): Memory => ({
  id,
  scope,
  botId,
  content: id,
  site: null,
  status: 'active',
  source: 'user',
  createdAt: '2026-11-16T00:00:00.000Z',
  updatedAt: '2026-11-16T00:00:00.000Z',
});

describe('botNoteGroups', () => {
  it('lists bots in use first, then archived ones, then unknown ones, and leaves shared notes out', () => {
    const memory = [
      note('u1', 'user', null),
      note('x1', 'bot', 'old'),
      note('k1', 'bot', 'kahya'),
      note('g1', 'bot', 'gone'),
      note('x2', 'bot', 'old'),
      note('k2', 'bot', 'kahya'),
    ];
    const groups = botNoteGroups(
      memory,
      [
        { id: 'pasa', name: 'Paşa' },
        { id: 'kahya', name: 'Kahya' },
      ],
      [{ id: 'old', name: 'Eski Kahya' }],
    );
    expect(groups.map((g) => [g.botId, g.name, g.archived, g.notes.map((n) => n.id)])).toEqual([
      ['kahya', 'Kahya', false, ['k1', 'k2']],
      ['old', 'Eski Kahya', true, ['x1', 'x2']],
      ['gone', null, false, ['g1']],
    ]);
  });
});
