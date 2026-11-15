import { describe, expect, it } from 'vitest';
import { defaultSendKey, keyAction } from './sendKey';

const key = (o: Partial<Parameters<typeof keyAction>[0]>) => ({
  key: 'Enter',
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  isComposing: false,
  ...o,
});

describe('gönderme tuşu', () => {
  it('Enter kipinde Enter gönderir, Shift+Enter satır kırar', () => {
    expect(keyAction(key({}), 'enter')).toBe('send');
    expect(keyAction(key({ shiftKey: true }), 'enter')).toBe('newline');
  });
  it('⌘/Ctrl kipinde yalnızca ⌘/Ctrl+Enter gönderir', () => {
    expect(keyAction(key({}), 'mod')).toBe('newline');
    expect(keyAction(key({ metaKey: true }), 'mod')).toBe('send');
    expect(keyAction(key({ ctrlKey: true }), 'mod')).toBe('send');
  });
  it('dokunmatik ekranda Enter varsayılan olarak satır kırar', () => {
    expect(defaultSendKey(true)).toBe('mod');
    expect(defaultSendKey(false)).toBe('enter');
  });
  it('yazı birleştirilirken ve başka tuşta bir şey yapmaz', () => {
    expect(keyAction(key({ isComposing: true }), 'enter')).toBeNull();
    expect(keyAction(key({ key: 'a' }), 'enter')).toBeNull();
  });
});
