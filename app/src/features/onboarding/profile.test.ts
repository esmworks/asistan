import { createTranslator, LOCALES, PROFILE_HELP } from '@yumakbot/shared';
import { describe, expect, it } from 'vitest';
import { en } from '@/i18n/en';
import { tr } from '@/i18n/tr';
import { availableStarters, STARTERS, starterBot, suggestedStarters } from './profile';

describe('starter bots', () => {
  it('offers the general bot first, then the chosen kinds of work in a fixed order', () => {
    expect(suggestedStarters([])).toEqual(['general']);
    expect(suggestedStarters(['code', 'research'])).toEqual(['general', 'research', 'code']);
  });

  it('has a name, description and instructions in every language', () => {
    for (const locale of LOCALES) {
      const t = createTranslator({ tr, en }, locale);
      for (const id of ['general', ...PROFILE_HELP] as const) {
        const bot = starterBot(id, t);
        for (const text of [bot.name, bot.description, bot.instructions]) {
          expect(text).not.toMatch(/^starter\./);
          expect(text.length).toBeGreaterThan(1);
        }
        expect(bot.avatar).toMatch(/^shape:/);
        expect(bot.color).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it('offers a new bot only the starters the person does not have yet', () => {
    const t = createTranslator({ tr, en }, 'tr');
    expect(availableStarters(t, [])).toEqual(STARTERS);
    const research = starterBot('research', t).name;
    const left = availableStarters(t, [` ${research.toLocaleLowerCase()} `, 'Kendi botum']);
    expect(left).not.toContain('research');
    expect(left).toHaveLength(STARTERS.length - 1);
  });
});
