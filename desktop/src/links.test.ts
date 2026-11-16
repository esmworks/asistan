import { describe, expect, it } from 'vitest';
import { linkInArgs, parseLink } from './links';

describe('parseLink', () => {
  it('reads the chats a link can name', () => {
    expect(parseLink('yumakbot://thread/abc_12')).toEqual({ kind: 'thread', id: 'abc_12' });
    expect(parseLink('yumakbot://bot/b1/')).toEqual({ kind: 'bot', id: 'b1' });
    expect(parseLink('yumakbot:room/r-9')).toEqual({ kind: 'room', id: 'r-9' });
  });

  it('refuses anything else', () => {
    for (const bad of [
      'https://thread/abc',
      'yumakbot://settings/x',
      'yumakbot://thread/',
      'yumakbot://thread/a/b',
      'yumakbot://thread/..%2F..',
      'not a url',
    ]) {
      expect(parseLink(bad)).toBeNull();
    }
  });

  it('finds the link among the arguments a second start gets', () => {
    expect(linkInArgs(['/opt/Yumak Bot/yumakbot', '--no-sandbox', 'yumakbot://bot/b1'])).toEqual({
      kind: 'bot',
      id: 'b1',
    });
    expect(linkInArgs(['/opt/Yumak Bot/yumakbot'])).toBeNull();
  });
});
