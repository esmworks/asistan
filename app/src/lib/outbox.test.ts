import type { Message } from '@yumakbot/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn();
vi.mock('./api', async (orig) => ({ ...(await orig<object>()), api: { send } }));
const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { error: toastError } }));

const { ApiError } = await import('./api');
const { flushOutbox, holdsFor, isOffline, useOutbox } = await import('./outbox');

const held = (clientId: string) => ({
  threadId: 't1',
  clientId,
  text: `metin ${clientId}`,
  files: [],
  message: { id: clientId, clientId, props: { heldOffline: true } } as unknown as Message,
});

describe('outbox', () => {
  beforeEach(() => {
    send.mockReset();
    toastError.mockReset();
    useOutbox.setState({ items: [] });
  });

  it('tells a refused send from one that never reached the server', () => {
    expect(isOffline(new TypeError('Failed to fetch'))).toBe(true);
    expect(isOffline(new ApiError(400, 'no'))).toBe(false);
    // A proxy's error page while the server restarts is no answer; the server's own 502 is one.
    expect(isOffline(new ApiError(502, 'Request failed (502)', false))).toBe(true);
    expect(isOffline(new ApiError(503, 'Request failed (503)', false))).toBe(true);
    expect(isOffline(new ApiError(502, 'Telegram unreachable'))).toBe(false);
  });

  it('tells whether a conversation has messages waiting, so a new one goes behind them', () => {
    expect(holdsFor('t1')).toBe(false);
    useOutbox.getState().hold(held('a'));
    expect(holdsFor('t1')).toBe(true);
    expect(holdsFor('t2')).toBe(false);
  });

  it('sends what was held in order, marked as written offline, with the same client id', async () => {
    useOutbox.getState().hold(held('a'));
    useOutbox.getState().hold(held('b'));
    send.mockResolvedValue({});
    const sent: string[] = [];
    await flushOutbox((id) => sent.push(id));
    expect(send.mock.calls.map((c) => [c[1], c[5]])).toEqual([
      ['a', true],
      ['b', true],
    ]);
    expect(useOutbox.getState().items).toEqual([]);
    expect(sent).toEqual(['t1', 't1']);
  });

  it('keeps the rest while the server still cannot be reached, and drops one it refuses', async () => {
    useOutbox.getState().hold(held('a'));
    useOutbox.getState().hold(held('b'));
    send.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await flushOutbox();
    expect(send).toHaveBeenCalledTimes(1);
    expect(useOutbox.getState().items.map((i) => i.clientId)).toEqual(['a', 'b']);

    send.mockRejectedValueOnce(new ApiError(403, 'yasak')).mockResolvedValueOnce({});
    await flushOutbox();
    expect(toastError).toHaveBeenCalledWith('yasak');
    expect(useOutbox.getState().items).toEqual([]);
  });

  it('holding the same message again keeps one copy', () => {
    useOutbox.getState().hold(held('a'));
    useOutbox.getState().hold(held('a'));
    expect(useOutbox.getState().items).toHaveLength(1);
  });
});
