import type { TurnChangeItem } from '@yumakbot/shared';
import { describe, expect, it } from 'vitest';
import { clock, rehearsalSeconds, restoredCount, startedBySomething, triggerKey, undoGroups } from './turns';

const item = (over: Partial<TurnChangeItem>): TurnChangeItem => ({
  id: 'x',
  kind: 'file',
  op: 'update',
  label: 'a.txt',
  reason: null,
  needsOwner: false,
  outcome: null,
  ...over,
});

describe('undo groups', () => {
  it('keeps what cannot be put back apart, even when it also needs the owner', () => {
    const g = undoGroups([
      item({ id: '1' }),
      item({ id: '2', needsOwner: true }),
      item({ id: '3', reason: 'deleted' }),
      item({ id: '4', reason: 'tooBig', needsOwner: true }),
    ]);
    expect(g.will.map((i) => i.id)).toEqual(['1']);
    expect(g.owner.map((i) => i.id)).toEqual(['2']);
    expect(g.kept.map((i) => i.id)).toEqual(['3', '4']);
  });

  it('counts only the changes that were put back', () => {
    expect(
      restoredCount([item({ outcome: 'restored' }), item({ outcome: null }), item({ outcome: 'restored' })]),
    ).toBe(2);
  });
});

describe('rehearsal helpers', () => {
  it('names the starter of a run, falling back to by hand', () => {
    expect(triggerKey('webhook')).toBe('rehearsal.trigger.webhook');
    expect(triggerKey('schedule')).toBe('rehearsal.trigger.manual');
    expect(triggerKey(null)).toBe('rehearsal.trigger.manual');
  });

  it('offers a replay only when something besides the schedule starts the routine', () => {
    const none = {
      watchUrl: null,
      check: null,
      webhookToken: null,
      emailTrigger: false,
      whatsappGroup: null,
      whatsappPeople: null,
    };
    expect(startedBySomething(none as never)).toBe(false);
    expect(startedBySomething({ ...none, webhookToken: 'abc' } as never)).toBe(true);
    expect(startedBySomething({ ...none, emailTrigger: true } as never)).toBe(true);
    expect(startedBySomething({ ...none, slackReaction: 'eyes' } as never)).toBe(true);
  });

  it('times a rehearsal once it has finished', () => {
    expect(rehearsalSeconds({ startedAt: '2026-01-01T10:00:00Z', finishedAt: null })).toBeNull();
    expect(rehearsalSeconds({ startedAt: '2026-01-01T10:00:00Z', finishedAt: '2026-01-01T10:01:05Z' })).toBe(
      65,
    );
    expect(clock(65)).toBe('1:05');
  });
});
