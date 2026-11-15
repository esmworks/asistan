import { describe, expect, it } from 'vitest';
import { activityOf, type ActivityInput } from './botActivity';

const base: ActivityInput = { state: 'idle', pendingApprovals: 0, streaming: false, browsing: false };
const of = (patch: Partial<ActivityInput>) => activityOf({ ...base, ...patch });

describe('avatarın gösterdiği iş', () => {
  it('boştayken durur', () => {
    expect(of({})).toBe('idle');
    // A leftover stream or browser after the turn ends does not animate the bot.
    expect(of({ streaming: true, browsing: true })).toBe('idle');
  });

  it('çalışan turda düşünür, yazar ya da tarayıcıda gezer', () => {
    expect(of({ state: 'running' })).toBe('thinking');
    expect(of({ state: 'running', streaming: true })).toBe('writing');
    expect(of({ state: 'running', streaming: true, browsing: true })).toBe('browsing');
  });

  it('sırada bekler', () => {
    expect(of({ state: 'queued' })).toBe('queued');
  });

  it('onay beklemesi her şeyin önüne geçer', () => {
    expect(of({ state: 'waiting' })).toBe('waiting');
    expect(of({ state: 'running', pendingApprovals: 2, browsing: true })).toBe('waiting');
  });
});
