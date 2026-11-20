import type { Approval, Bot, Message } from '@leafbot/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CardDock, MessageItem } from './MessageItem';

const message = (id: string, role: Message['role'], props: Message['props'] = {}): Message => ({
  id,
  threadId: role === 'marker' ? 't1' : 't2',
  role,
  author: 'bot:b2',
  text: id === 'q1' ? 'Depo bir komut çalıştırmak istiyor' : id,
  props,
  clientId: null,
  turnId: null,
  createdAt: '2026-11-18T00:00:00.000Z',
});

const approval = (status: Approval['status']): Approval => ({
  id: 'a1',
  threadId: 't2',
  botId: 'b2',
  kind: 'tool',
  toolName: 'Bash',
  summary: 'Depo bir komut çalıştırmak istiyor',
  input: { command: 'ls' },
  options: [],
  status,
  answer: null,
  remembered: false,
  createdAt: '2026-11-18T00:00:00.000Z',
  decidedAt: null,
});

/** A conversation with an exchange between bots in it, whose card waits or was answered. */
function show(status: Approval['status']) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(['approvals'], [approval(status)]);
  qc.setQueryData(['job', 'j1'], {
    job: { id: 'j1', toThreadId: 't2' },
    messages: [message('w1', 'user'), message('q1', 'approval', { approvalId: 'a1' })],
  });
  const dock = document.createElement('div');
  const marker = message('k1', 'marker', { jobId: 'j1', peerBotId: 'b2', count: 1 });
  const view = render(
    <QueryClientProvider client={qc}>
      <CardDock.Provider value={dock}>
        <MessageItem m={marker} bots={new Map<string, Bot>()} />
      </CardDock.Provider>
    </QueryClientProvider>,
  );
  return { dock, view };
}

describe('botlar arası konuşmadaki kart', () => {
  afterEach(cleanup);

  it('cevap bekleyen kart sohbetin sonunda çıkar, konuşmanın içinde değil', () => {
    const { dock, view } = show('pending');
    expect(dock.textContent).toContain('Allow this time');
    expect(view.container.textContent).not.toContain('Allow this time');
  });

  it('cevaplanan kart konuşmanın geçmişinde kalır', () => {
    const { dock } = show('allowed');
    expect(dock.textContent).toBe('');
  });
});
