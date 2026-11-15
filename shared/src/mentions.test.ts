import { describe, expect, it } from 'vitest';
import { findMentions } from './mentions';

const bots = [
  { id: 'a', name: 'Ada' },
  { id: 'al', name: 'Ada Lovelace' },
  { id: 'i', name: 'İlker' },
  { id: 's', name: 'Satış Botu' },
];

describe('findMentions', () => {
  it('finds names in the order they appear, once each', () => {
    expect(findMentions('@Satış Botu ve @ada, sonra yine @Ada', bots)).toEqual({
      ids: ['s', 'a'],
      everyone: false,
    });
  });

  it('takes the longest name that fits', () => {
    expect(findMentions('@Ada Lovelace ne dersin?', bots).ids).toEqual(['al']);
  });

  it('ignores case, Turkish letters included', () => {
    expect(findMentions('@ilker bakar mısın', bots).ids).toEqual(['i']);
  });

  it('needs the name to end at a word boundary', () => {
    expect(findMentions('@Adam selam', bots).ids).toEqual([]);
  });

  it('does not take an e-mail address for a mention', () => {
    expect(findMentions('ada@example.com', bots).ids).toEqual([]);
  });

  it('knows the words for everyone', () => {
    expect(findMentions('@herkes toplanın', bots)).toEqual({ ids: [], everyone: true });
    expect(findMentions('hi @everyone', bots).everyone).toBe(true);
  });
});
