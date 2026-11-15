import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VncChannel, type VncSocket } from './vnc-channel';

type Handler = (...args: never[]) => void;

/** A socket that records what the channel emits and lets the test push events in. */
function fakeSocket(connected = true) {
  const handlers = new Map<string, Set<Handler>>();
  const emitted: { event: string; args: unknown[] }[] = [];
  let ack: ((r: { ok: boolean; error?: string }) => void) | null = null;
  const socket = {
    connected,
    emit: (event: string, ...args: unknown[]) => {
      emitted.push({ event, args });
      if (event === 'vnc:open') ack = args[1] as typeof ack;
    },
    on: (event: string, fn: Handler) =>
      void (handlers.get(event) ?? handlers.set(event, new Set()).get(event)!).add(fn),
    off: (event: string, fn: Handler) => void handlers.get(event)?.delete(fn),
  };
  return {
    socket: socket as unknown as VncSocket,
    emitted,
    answer: (r: { ok: boolean; error?: string }) => ack?.(r),
    push: (event: string, payload?: unknown) =>
      handlers.get(event)?.forEach((fn) => (fn as (p: unknown) => void)(payload)),
    listeners: (event: string) => handlers.get(event)?.size ?? 0,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('vnc kanalı', () => {
  it('açılırken vnc:open yollar, onay gelince open olur', () => {
    const f = fakeSocket();
    const c = new VncChannel(f.socket, 'b1');
    const onopen = vi.fn();
    c.onopen = onopen;
    expect(f.emitted[0]).toMatchObject({ event: 'vnc:open', args: ['b1', expect.any(Function)] });
    expect(c.readyState).toBe(0);
    f.answer({ ok: true });
    expect(c.readyState).toBe(1);
    expect(onopen).toHaveBeenCalledOnce();
  });

  it('onay reddedilirse hata ve kapanış bildirir', () => {
    const f = fakeSocket();
    const c = new VncChannel(f.socket, 'b1');
    const onerror = vi.fn();
    const onclose = vi.fn();
    c.onerror = onerror;
    c.onclose = onclose;
    f.answer({ ok: false, error: 'nope' });
    expect(c.readyState).toBe(3);
    expect(onerror).toHaveBeenCalledOnce();
    expect(onclose).toHaveBeenCalledOnce();
    expect(f.listeners('vnc:data')).toBe(0);
  });

  it('soket bağlı değilse kapanır', async () => {
    const f = fakeSocket(false);
    const c = new VncChannel(f.socket, 'b1');
    const onclose = vi.fn();
    c.onclose = onclose;
    await vi.runAllTimersAsync();
    expect(onclose).toHaveBeenCalledOnce();
    expect(f.emitted).toEqual([]);
  });

  it('veriyi yalnızca kendi botuna yönlendirir', () => {
    const f = fakeSocket();
    const c = new VncChannel(f.socket, 'b1');
    f.answer({ ok: true });
    const got: ArrayBuffer[] = [];
    c.onmessage = (e) => got.push(e.data);
    f.push('vnc:data', { botId: 'b2', data: new Uint8Array([9]) });
    f.push('vnc:data', { botId: 'b1', data: new Uint8Array([1, 2]).buffer });
    f.push('vnc:data', { botId: 'b1', data: new Uint8Array([0, 3, 4, 5]).subarray(1, 3) });
    expect(got.map((b) => [...new Uint8Array(b)])).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('işleyici bağlanmadan gelen veriyi saklayıp sonra iletir', () => {
    const f = fakeSocket();
    const c = new VncChannel(f.socket, 'b1');
    f.answer({ ok: true });
    f.push('vnc:data', { botId: 'b1', data: new Uint8Array([7]) });
    const got: number[][] = [];
    c.onmessage = (e) => got.push([...new Uint8Array(e.data)]);
    expect(got).toEqual([[7]]);
  });

  it('gönderirken kopyalar ve botId ekler; açık değilken göndermez', () => {
    const f = fakeSocket();
    const c = new VncChannel(f.socket, 'b1');
    c.send(new Uint8Array([1]));
    expect(f.emitted).toHaveLength(1);
    f.answer({ ok: true });
    const shared = new Uint8Array([1, 2, 3, 4]);
    c.send(shared.subarray(1, 3));
    shared.fill(0);
    const sent = f.emitted[1]!;
    expect(sent.event).toBe('vnc:data');
    const payload = sent.args[0] as { botId: string; data: Uint8Array };
    expect(payload.botId).toBe('b1');
    expect([...payload.data]).toEqual([2, 3]);
  });

  it('close() vnc:close yollar ve kapanışı sonradan bildirir', async () => {
    const f = fakeSocket();
    const c = new VncChannel(f.socket, 'b1');
    f.answer({ ok: true });
    const onclose = vi.fn();
    c.onclose = onclose;
    c.close();
    expect(f.emitted.at(-1)).toMatchObject({ event: 'vnc:close', args: ['b1'] });
    expect(c.readyState).toBe(2);
    expect(onclose).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(c.readyState).toBe(3);
    expect(onclose).toHaveBeenCalledOnce();
    expect(f.listeners('vnc:data')).toBe(0);
    c.close();
    expect(f.emitted.filter((e) => e.event === 'vnc:close')).toHaveLength(1);
  });

  it('sunucu vnc:closed derse kapanır; başka botunki etkilemez', () => {
    const f = fakeSocket();
    const c = new VncChannel(f.socket, 'b1');
    f.answer({ ok: true });
    const onclose = vi.fn();
    c.onclose = onclose;
    f.push('vnc:closed', { botId: 'b2' });
    expect(onclose).not.toHaveBeenCalled();
    f.push('vnc:closed', { botId: 'b1' });
    expect(c.readyState).toBe(3);
    expect(onclose).toHaveBeenCalledOnce();
    expect(f.emitted.some((e) => e.event === 'vnc:close')).toBe(false);
  });

  it('soket kopunca kapanır', () => {
    const f = fakeSocket();
    const c = new VncChannel(f.socket, 'b1');
    f.answer({ ok: true });
    const onclose = vi.fn();
    c.onclose = onclose;
    f.push('disconnect');
    expect(onclose).toHaveBeenCalledOnce();
  });

  it("noVNC'nin istediği üyelerin hepsi var", () => {
    const c = new VncChannel(fakeSocket().socket, 'b1');
    const own = [...Object.keys(c), ...Object.getOwnPropertyNames(Object.getPrototypeOf(c))];
    for (const p of [
      'send',
      'close',
      'binaryType',
      'onerror',
      'onmessage',
      'onopen',
      'protocol',
      'readyState',
    ]) {
      expect(own).toContain(p);
    }
  });
});
