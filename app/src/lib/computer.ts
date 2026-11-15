import type {
  ClientToServerEvents,
  ComputerAck,
  ComputerState,
  ServerToClientEvents,
} from '@yumakbot/shared';
import type { Socket } from 'socket.io-client';
import { create } from 'zustand';
import { VncChannel } from './vnc-channel';

type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

interface Computers {
  states: Record<string, ComputerState>;
  setState(s: ComputerState): void;
  drop(botId: string): void;
}

/** The bots' computers, for the ones being watched (and any the server pushes). */
export const useComputers = create<Computers>((set) => ({
  states: {},
  setState: (s) => set((cur) => ({ states: { ...cur.states, [s.botId]: s } })),
  drop: (botId) =>
    set((cur) => {
      const states = { ...cur.states };
      delete states[botId];
      return { states };
    }),
}));

let socket: AppSocket | null = null;
/** How many parts of the page watch each bot; the server is told only on the first and the last. */
const watchers = new Map<string, number>();

function sendWatch(s: AppSocket, botId: string) {
  s.emit('computer:watch', botId, (state) => {
    if (state) useComputers.getState().setState(state);
  });
}

export function onComputerReconnect(s: AppSocket) {
  socket = s;
  for (const botId of watchers.keys()) sendWatch(s, botId);
}

export function computerSocketClosed(s: AppSocket) {
  if (socket === s) socket = null;
}

/** Start following a bot's computer; call the returned function to stop. */
export function watchComputer(botId: string): () => void {
  const n = watchers.get(botId) ?? 0;
  watchers.set(botId, n + 1);
  if (n === 0 && socket?.connected) sendWatch(socket, botId);
  return () => {
    const left = (watchers.get(botId) ?? 1) - 1;
    if (left > 0) return void watchers.set(botId, left);
    watchers.delete(botId);
    socket?.emit('computer:unwatch', botId);
  };
}

function request(
  send: (s: AppSocket, done: (r: ComputerAck) => void) => void,
  timeoutMs: number,
): Promise<ComputerAck> {
  return new Promise((resolve) => {
    if (!socket?.connected) return resolve({ ok: false, error: '' });
    const timer = setTimeout(() => resolve({ ok: false, error: '' }), timeoutMs);
    send(socket, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
  });
}

/** Start the desktop; it can take a while to come up. */
export function wakeComputer(botId: string): Promise<ComputerAck> {
  return request((s, done) => s.emit('computer:wake', botId, done), 120_000);
}

/** Take the mouse and keyboard, or give them back to the bot. */
export function setComputerControl(botId: string, on: boolean): Promise<ComputerAck> {
  return request((s, done) => s.emit('computer:control', { botId, on }, done), 45_000);
}

/** A live-screen channel for the viewer, or null while the socket is down. */
export function openVnc(botId: string): VncChannel | null {
  return socket?.connected ? new VncChannel(socket, botId) : null;
}
