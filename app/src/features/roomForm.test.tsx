import type { Bot, Room } from '@yumakbot/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { useUi } from '@/lib/store';
import { RoomDialog } from './Rooms';

vi.mock('@/lib/api', () => ({
  api: { updateRoom: vi.fn(), createRoom: vi.fn(), deleteRoom: vi.fn(), bots: vi.fn(), rooms: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
// The animated avatar needs a browser's media queries; the picker's order is what is under test.
vi.mock('@/components/BotAvatar', () => ({ BotAvatar: () => null }));

const bot = (id: string, name: string) => ({ id, name, description: '', color: '', avatar: '' }) as Bot;

const room: Room = {
  id: 'r1',
  title: 'Yönetim',
  goal: '',
  // `gone` was archived after it joined: the bot list no longer has it.
  members: ['gone', 'b1'],
  responders: 'everyone',
  rounds: 0,
  minutes: 'ask',
  meeting: null,
  state: 'idle',
  speakerId: null,
  preview: null,
  createdAt: '2026-11-20T00:00:00.000Z',
  updatedAt: '2026-11-20T00:00:00.000Z',
};

function show() {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(['bots'], [bot('b1', 'Paşa'), bot('b2', 'Depo')]);
  qc.setQueryData(['rooms'], [room]);
  useUi.getState().openRoomDialog({ mode: 'edit', roomId: 'r1' });
  render(
    <QueryClientProvider client={qc}>
      <RoomDialog />
    </QueryClientProvider>,
  );
}

const pick = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find((b) =>
    b.textContent?.includes(name),
  )!;

afterEach(() => {
  cleanup();
  useUi.getState().openRoomDialog(null);
  vi.mocked(api.updateRoom).mockReset();
});

describe('editing a room with an archived member', () => {
  it('numbers and saves only the bots that can still be picked', async () => {
    vi.mocked(api.updateRoom).mockResolvedValue(room);
    show();
    expect(pick('Paşa').textContent).toContain('1');
    fireEvent.click(pick('Depo'));
    expect(pick('Depo').textContent).toContain('2');
    fireEvent.submit(document.querySelector('form')!);
    await waitFor(() => expect(api.updateRoom).toHaveBeenCalled());
    expect(vi.mocked(api.updateRoom).mock.calls[0]![1].botIds).toEqual(['b1', 'b2']);
  });

  it('lets the last bot that can be picked be taken out', () => {
    show();
    fireEvent.click(pick('Paşa'));
    expect(pick('Paşa').getAttribute('aria-pressed')).toBe('false');
  });
});
