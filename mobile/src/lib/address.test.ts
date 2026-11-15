import { describe, expect, it } from 'vitest';
import { candidates, hostOf } from './address';

describe('candidates', () => {
  it('tries https then http when no scheme is typed', () => {
    expect(candidates('192.168.1.20:4319')).toEqual([
      'https://192.168.1.20:4319',
      'http://192.168.1.20:4319',
    ]);
  });

  it('keeps the scheme that was typed', () => {
    expect(candidates('http://yumakbot.local:4319/')).toEqual(['http://yumakbot.local:4319']);
  });

  it('drops the path and surrounding space', () => {
    expect(candidates('  https://example.com/app//  ')).toEqual(['https://example.com']);
  });

  it('gives nothing for an empty or non-web address', () => {
    expect(candidates('   ')).toEqual([]);
    expect(candidates('ftp://example.com')).toEqual([]);
    expect(candidates('http://')).toEqual([]);
  });
});

describe('hostOf', () => {
  it('shows host and port', () => {
    expect(hostOf('http://192.168.1.20:4319')).toBe('192.168.1.20:4319');
  });
});
