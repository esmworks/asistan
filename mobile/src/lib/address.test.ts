import { describe, expect, it } from 'vitest';
import { candidates, hostOf, insecure, isLocalHost } from './address';

describe('candidates', () => {
  it('tries https then http for a server on the local network', () => {
    expect(candidates('192.168.1.20:4319')).toEqual([
      'https://192.168.1.20:4319',
      'http://192.168.1.20:4319',
    ]);
    expect(candidates('yumakbot.local:4319')).toEqual([
      'https://yumakbot.local:4319',
      'http://yumakbot.local:4319',
    ]);
  });

  it('tries only https for a server on the internet, so it never falls back to plain http', () => {
    expect(candidates('bot.example.com')).toEqual(['https://bot.example.com']);
    expect(candidates('203.0.113.7:4319')).toEqual(['https://203.0.113.7:4319']);
  });

  it('keeps the scheme that was typed', () => {
    expect(candidates('http://yumakbot.local:4319/')).toEqual(['http://yumakbot.local:4319']);
    expect(candidates('http://bot.example.com')).toEqual(['http://bot.example.com']);
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

describe('isLocalHost', () => {
  it('accepts loopback, private, link-local and tailnet addresses', () => {
    for (const host of [
      'localhost',
      '127.0.0.1',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.20',
      '169.254.10.1',
      '100.101.102.103',
      '[::1]',
      '[fd12:3456::1]',
      '[fe80::1]',
      'nas',
      'yumakbot.local',
      'box.home.arpa',
      'yumakbot.tail1234.ts.net',
    ]) {
      expect(isLocalHost(host), host).toBe(true);
    }
  });

  it('refuses public addresses and names', () => {
    for (const host of [
      'bot.example.com',
      '8.8.8.8',
      '172.32.0.1',
      '100.128.0.1',
      '192.169.0.1',
      '[2001:db8::1]',
      '[fc::1]',
      'local.example.com',
      'evil-ts.net',
    ]) {
      expect(isLocalHost(host), host).toBe(false);
    }
  });
});

describe('insecure', () => {
  it('flags plain http to the internet only', () => {
    expect(insecure('http://bot.example.com')).toBe(true);
    expect(insecure('https://bot.example.com')).toBe(false);
    expect(insecure('http://192.168.1.20:4319')).toBe(false);
  });
});

describe('hostOf', () => {
  it('shows host and port', () => {
    expect(hostOf('http://192.168.1.20:4319')).toBe('192.168.1.20:4319');
  });
});
