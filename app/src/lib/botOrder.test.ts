import type { Bot, Group } from '@leafbot/shared';
import { describe, expect, it } from 'vitest';
import { botShortcut, botStep, sidebarOrder } from './botOrder';

const bot = (id: string, over: Partial<Bot> = {}) => ({ id, pinned: false, groupId: null, ...over }) as Bot;

describe('kenar çubuğu sırası', () => {
  it('bekleyenler, sabitlenenler, gruplar ve grupsuzlar sırasıyla gelir', () => {
    const groups = [{ id: 'g1' }, { id: 'g2' }] as Group[];
    const bots = [
      bot('a'),
      bot('b', { groupId: 'g2' }),
      bot('c', { groupId: 'g1' }),
      bot('d', { pinned: true }),
      bot('e'),
    ];
    expect(sidebarOrder(bots, groups, new Set(['e'])).map((b) => b.id)).toEqual(['e', 'd', 'c', 'b', 'a']);
  });

  it('⌘/Ctrl+Shift ile ] ve [ botlar arasında ileri ve geri gider', () => {
    const k = (code: string, o = {}) => ({
      code,
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
      ...o,
    });
    expect(botStep(k('BracketRight'))).toBe(1);
    expect(botStep(k('BracketLeft'))).toBe(-1);
    expect(botStep(k('BracketRight', { shiftKey: false }))).toBeNull();
    expect(botStep(k('KeyA'))).toBeNull();
  });

  it('yalnızca ⌘/Ctrl ile 1–9 bir yer ister', () => {
    const k = (key: string, o = {}) => ({
      key,
      metaKey: false,
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
      ...o,
    });
    expect(botShortcut(k('1'))).toBe(0);
    expect(botShortcut(k('9'))).toBe(8);
    expect(botShortcut(k('0'))).toBeNull();
    expect(botShortcut(k('2', { ctrlKey: false }))).toBeNull();
    expect(botShortcut(k('2', { shiftKey: true }))).toBeNull();
  });
});
