import type {
  BrowserAck,
  BrowserFrame,
  BrowserInput,
  BrowserState,
  ClientToServerEvents,
  ServerToClientEvents,
} from '@yumakbot/shared';
import type { Socket } from 'socket.io-client';
import { create } from 'zustand';

type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export interface Screen {
  /** Object URL of the latest JPEG frame. */
  url: string;
  width: number;
  height: number;
}

interface Browsers {
  states: Record<string, BrowserState>;
  screens: Record<string, Screen>;
  setState(s: BrowserState): void;
  setFrame(f: BrowserFrame): void;
}

/** The bots' browsers: state for every bot, the screen only for the ones being watched. */
export const useBrowsers = create<Browsers>((set, get) => ({
  states: {},
  screens: {},
  setState: (s) => set((cur) => ({ states: { ...cur.states, [s.botId]: s } })),
  setFrame: (f) => {
    if (!watchers.has(f.botId)) return;
    const url = URL.createObjectURL(new Blob([f.data as BlobPart], { type: 'image/jpeg' }));
    const old = get().screens[f.botId];
    set((cur) => ({ screens: { ...cur.screens, [f.botId]: { url, width: f.width, height: f.height } } }));
    // The old frame may still be on screen for a moment; free it after the new one has painted.
    if (old) setTimeout(() => URL.revokeObjectURL(old.url), 1000);
  },
}));

let socket: AppSocket | null = null;
/** How many parts of the page watch each bot; the server is told only on the first and the last. */
const watchers = new Map<string, number>();

function sendWatch(s: AppSocket, botId: string) {
  s.emit('browser:watch', botId, (state) => {
    if (state) useBrowsers.getState().setState(state);
  });
}

export function onBrowserReconnect(s: AppSocket) {
  socket = s;
  for (const botId of watchers.keys()) sendWatch(s, botId);
}

export function browserSocketClosed(s: AppSocket) {
  if (socket === s) socket = null;
}

/** Start receiving a bot's screen; call the returned function to stop. */
export function watchBrowser(botId: string): () => void {
  const n = watchers.get(botId) ?? 0;
  watchers.set(botId, n + 1);
  if (n === 0 && socket?.connected) sendWatch(socket, botId);
  return () => {
    const left = (watchers.get(botId) ?? 1) - 1;
    if (left > 0) return void watchers.set(botId, left);
    watchers.delete(botId);
    socket?.emit('browser:unwatch', botId);
    const screen = useBrowsers.getState().screens[botId];
    if (screen) {
      URL.revokeObjectURL(screen.url);
      useBrowsers.setState((cur) => {
        const screens = { ...cur.screens };
        delete screens[botId];
        return { screens };
      });
    }
  };
}

export function setBrowserControl(botId: string, on: boolean): Promise<BrowserAck> {
  return new Promise((resolve) => {
    if (!socket?.connected) return resolve({ ok: false, error: '' });
    socket
      .timeout(45_000)
      .emit('browser:control', { botId, on }, (err, r) => resolve(err ? { ok: false, error: '' } : r));
  });
}

export function sendBrowserInput(botId: string, input: BrowserInput) {
  socket?.emit('browser:input', { botId, input });
}
