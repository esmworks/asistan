import { describe, expect, it } from 'vitest';
import { isQuickView, quickAction, shortcutLabel } from './quick';

describe('isQuickView', () => {
  it('is on only for ?quick=1', () => {
    expect(isQuickView('?quick=1')).toBe(true);
    expect(isQuickView('?thread=x&quick=1')).toBe(true);
    expect(isQuickView('')).toBe(false);
    expect(isQuickView('?quick=0')).toBe(false);
  });
});

describe('quickAction', () => {
  const tool = { kind: 'tool' } as const;
  const question = { kind: 'question', options: 3 } as const;
  const open = { kind: 'open' } as const;

  it('moves and closes whatever is selected', () => {
    expect(quickAction({ key: 'j' }, null)).toEqual({ type: 'move', by: 1 });
    expect(quickAction({ key: 'ArrowUp' }, tool)).toEqual({ type: 'move', by: -1 });
    expect(quickAction({ key: 'K' }, tool)).toEqual({ type: 'move', by: -1 });
    expect(quickAction({ key: 'Escape' }, null)).toEqual({ type: 'close' });
  });

  it('allows or denies a tool with 1 and 2', () => {
    expect(quickAction({ key: '1' }, tool)).toEqual({ type: 'allow' });
    expect(quickAction({ key: '2' }, tool)).toEqual({ type: 'deny' });
    expect(quickAction({ key: '3' }, tool)).toBeNull();
    expect(quickAction({ key: 'r' }, tool)).toBeNull();
  });

  it('picks only options the question has', () => {
    expect(quickAction({ key: '1' }, question)).toEqual({ type: 'choose', index: 0 });
    expect(quickAction({ key: '3' }, question)).toEqual({ type: 'choose', index: 2 });
    expect(quickAction({ key: '4' }, question)).toBeNull();
    expect(quickAction({ key: '0' }, question)).toBeNull();
    expect(quickAction({ key: 'R' }, question)).toEqual({ type: 'write' });
  });

  it('opens the conversation with O or Enter, and nothing else on a card it cannot answer', () => {
    expect(quickAction({ key: 'o' }, open)).toEqual({ type: 'open' });
    expect(quickAction({ key: 'Enter' }, question)).toEqual({ type: 'open' });
    expect(quickAction({ key: '1' }, open)).toBeNull();
  });

  it('leaves keys held with a modifier to the system', () => {
    expect(quickAction({ key: '1', metaKey: true }, tool)).toBeNull();
    expect(quickAction({ key: 'j', ctrlKey: true }, tool)).toBeNull();
  });
});

describe('shortcutLabel', () => {
  it('writes the keys as each system names them', () => {
    expect(shortcutLabel('Alt+Space', true)).toEqual(['⌥', 'Space']);
    expect(shortcutLabel('Control+Alt+Space', true)).toEqual(['⌃', '⌥', 'Space']);
    expect(shortcutLabel('Control+Alt+Space', false)).toEqual(['Ctrl', 'Alt', 'Space']);
    expect(shortcutLabel('CommandOrControl+Shift+Space', true)).toEqual(['⌘', '⇧', 'Space']);
    expect(shortcutLabel('CommandOrControl+Shift+Space', false)).toEqual(['Ctrl', 'Shift', 'Space']);
  });
});
