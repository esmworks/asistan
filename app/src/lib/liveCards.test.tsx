import type { Message } from '@leafbot/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useLiveCards } from './liveCards';
import { useUi, type Stream } from './store';

const msg = (
  id: string,
  role: Message['role'],
  turnId: string | null,
  props: Message['props'] = {},
): Message => ({
  id,
  threadId: 't1',
  role,
  author: role === 'user' ? 'user' : 'bot:b1',
  text: id,
  props,
  clientId: null,
  turnId,
  createdAt: '2026-11-18T00:00:00.000Z',
});

function setup(pending: string[] = []) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(
    ['approvals'],
    pending.map((id) => ({ id, status: 'pending' })),
  );
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return wrapper;
}

/** What the conversation shows, in order: row ids, then the streaming reply's pieces. */
const shown = (r: ReturnType<typeof useLiveCards>) => [
  ...r.rows.map((m) => m.id),
  ...r.parts.map((p) => (p.kind === 'card' ? p.card.id : `"${p.text}"`)),
];

describe('useLiveCards', () => {
  beforeEach(() => act(() => useUi.getState().resetLive()));
  // A hook left mounted would note the next test's cards against its own stream.
  afterEach(cleanup);

  it('akış sürerken sorulan kartı yazılan metnin altına koyar, sonraki metni kartın altına', () => {
    const wrapper = setup();
    const ask = msg('m1', 'user', null);
    const card = msg('q1', 'approval', 'turn-1', { approvalId: 'a1' });
    let rows = [ask];
    let stream: Stream = { turnId: 'turn-1', text: 'Rapor hazır.' };
    const { result, rerender } = renderHook(() => useLiveCards(rows, stream, false), { wrapper });
    expect(shown(result.current)).toEqual(['m1', '"Rapor hazır."']);

    // The card is saved while the bot waits; the reply so far is not.
    rows = [ask, card];
    rerender();
    expect(shown(result.current)).toEqual(['m1', '"Rapor hazır."', 'q1']);

    // After the answer the bot writes on: those words go below the card.
    stream = { turnId: 'turn-1', text: 'Rapor hazır. Yazdım.' };
    rerender();
    expect(shown(result.current)).toEqual(['m1', '"Rapor hazır."', 'q1', '" Yazdım."']);
  });

  it('henüz bir şey yazılmadan sorulan kart, sonra gelen metnin üstünde kalır', () => {
    const wrapper = setup(['a1']);
    const card = msg('q1', 'approval', 'turn-1', { approvalId: 'a1' });
    let stream: Stream | undefined = undefined;
    const { result, rerender } = renderHook(() => useLiveCards([card], stream, false), { wrapper });
    expect(shown(result.current)).toEqual(['q1']);

    stream = { turnId: 'turn-1', text: 'Tamam.' };
    rerender();
    expect(shown(result.current)).toEqual(['q1', '"Tamam."']);
  });

  it('kaydedilen cevap gelince kart yine kendi satırındadır', () => {
    const wrapper = setup();
    const card = msg('q1', 'approval', 'turn-1', { approvalId: 'a1' });
    const saved = msg('r1', 'assistant', 'turn-1');
    const stream: Stream = { turnId: 'turn-1', text: 'Rapor.' };
    let rows = [card];
    let done = false;
    const { result, rerender } = renderHook(() => useLiveCards(rows, stream, done), { wrapper });
    expect(shown(result.current)).toEqual(['"Rapor."', 'q1']);

    rows = [card, saved];
    done = true;
    rerender();
    expect(shown(result.current)).toEqual(['q1', 'r1']);
  });

  it('başka bir turun kartına dokunmaz', () => {
    const wrapper = setup();
    const old = msg('q0', 'approval', 'turn-0', { approvalId: 'a0' });
    const stream: Stream = { turnId: 'turn-1', text: 'Yeni.' };
    const { result } = renderHook(() => useLiveCards([old], stream, false), { wrapper });
    expect(shown(result.current)).toEqual(['q0', '"Yeni."']);
  });
});
