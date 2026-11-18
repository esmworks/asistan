import { describe, expect, it } from 'vitest';
import { reviewPrompt } from './review';

const base = {
  toolName: 'Bash',
  input: { command: 'git log --oneline -20' },
  bot: { name: 'Bug Hunter', description: '' },
  words: ['Check the commits that landed on main in the last 24 hours.'],
  locale: 'en' as const,
};

describe('reviewPrompt', () => {
  // A routine runs with nobody there: its instructions say what to look at, never the exact
  // commit or file, and the reads that goal needs must not wait on a card.
  it('lets the words that state a goal cover the reads it needs', () => {
    const { system } = reviewPrompt({ ...base, outside: false });
    expect(system).toContain('The user names a goal, not every step');
    expect(system).toContain('Quote the words that state the goal.');
  });

  it('keeps reads of what the request names allowed after outside text, and only then says so', () => {
    const line = 'Reading or inspecting the things the request itself names';
    expect(reviewPrompt({ ...base, outside: true }).system).toContain(line);
    expect(reviewPrompt({ ...base, outside: false }).system).not.toContain(line);
  });
});
