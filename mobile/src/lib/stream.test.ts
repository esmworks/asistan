import type { Message } from '@yumakbot/shared';
import { describe, expect, it } from 'vitest';
import { appendStream, dropStream, newClientId, streamSaved, withPending } from './stream';

function msg(over: Partial<Message>): Message {
  return {
    id: 'm1',
    threadId: 't1',
    role: 'assistant',
    author: 'bot:b1',
    text: '',
    props: {},
    clientId: null,
    turnId: null,
    createdAt: '2026-11-15T10:00:00.000Z',
    ...over,
  };
}

describe('stream', () => {
  it('joins pieces of one turn and starts over on a new one', () => {
    let s = appendStream({}, 't1', 'a', 'Mer');
    s = appendStream(s, 't1', 'a', 'haba');
    expect(s.t1).toEqual({ turnId: 'a', text: 'Merhaba' });
    s = appendStream(s, 't1', 'b', 'Yeni');
    expect(s.t1).toEqual({ turnId: 'b', text: 'Yeni' });
  });

  it('drops only the turn it was asked to', () => {
    const s = appendStream({}, 't1', 'b', 'x');
    expect(dropStream(s, 't1', 'a')).toBe(s);
    expect(dropStream(s, 't1', 'b')).toEqual({});
    expect(dropStream(s, 't1')).toEqual({});
    expect(dropStream(s, 't2')).toBe(s);
  });

  it('knows when the saved reply has arrived', () => {
    const stream = { turnId: 'a', text: 'x' };
    expect(streamSaved(stream, [msg({ turnId: 'a', role: 'user' })])).toBe(false);
    expect(streamSaved(stream, [msg({ turnId: 'a' })])).toBe(true);
    expect(streamSaved(undefined, [msg({ turnId: 'a' })])).toBe(false);
  });

  it('shows a sent message once, whichever arrives first', () => {
    const pending = msg({ id: 'local', role: 'user', clientId: 'c1' });
    expect(withPending([], [pending])).toEqual([pending]);
    const saved = msg({ id: 'm2', role: 'user', clientId: 'c1' });
    expect(withPending([saved], [pending])).toEqual([saved]);
  });

  it('makes client ids the server accepts', () => {
    const a = newClientId();
    expect(a.length).toBeGreaterThanOrEqual(8);
    expect(a.length).toBeLessThanOrEqual(64);
    expect(newClientId()).not.toBe(a);
  });
});
