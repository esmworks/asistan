import { contextBridge, ipcRenderer } from 'electron';

// The page gets only these calls; no Node or Electron objects cross the bridge.
contextBridge.exposeInMainWorld('yumakbotDesktop', {
  /** True when the window has no title bar and the page must leave room for the window buttons. */
  framelessTitleBar: process.platform === 'darwin',
  accessKey: (): Promise<string | null> => ipcRenderer.invoke('yumakbot:access-key'),
  connectRemote: (url: string, key: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('yumakbot:connect-remote', url, key),
  useLocal: (): Promise<void> => ipcRenderer.invoke('yumakbot:use-local'),
  server: (): Promise<{ mode: 'local' | 'remote'; url: string | null } | null> =>
    ipcRenderer.invoke('yumakbot:server'),
  openConnect: (): Promise<void> => ipcRenderer.invoke('yumakbot:open-connect'),
  setLocale: (locale: string): Promise<void> => ipcRenderer.invoke('yumakbot:set-locale', locale),
  setUnread: (count: number): Promise<void> => ipcRenderer.invoke('yumakbot:set-unread', count),
  setBusy: (busy: boolean): Promise<void> => ipcRenderer.invoke('yumakbot:set-busy', busy),
  showLogs: (): Promise<void> => ipcRenderer.invoke('yumakbot:show-logs'),
  /** Whether the app opens at login; with `on`, sets it first. */
  openAtLogin: (on?: boolean): Promise<boolean | null> => ipcRenderer.invoke('yumakbot:open-at-login', on),
  /** The chat a `yumakbot://` link asked to open, once; null when there is none. */
  takeLink: (): Promise<{ kind: 'thread' | 'bot' | 'room'; id: string } | null> =>
    ipcRenderer.invoke('yumakbot:take-link'),
  /** Calls `fn` when a link arrives while the page is open; returns a function that stops it. */
  onOpenLink: (fn: () => void): (() => void) => {
    const listener = () => fn();
    ipcRenderer.on('yumakbot:open-link', listener);
    return () => ipcRenderer.removeListener('yumakbot:open-link', listener);
  },
  /** Puts the quick window away. */
  quickHide: (): Promise<void> => ipcRenderer.invoke('yumakbot:quick-hide'),
  /** Opens a conversation in the main window (from the quick window). */
  openThread: (id: string): Promise<void> => ipcRenderer.invoke('yumakbot:open-thread', id),
  /** The global shortcut that opens the quick window, or null when none was free. */
  quickKey: (): Promise<string | null> => ipcRenderer.invoke('yumakbot:quick-key'),
  /** Calls `fn` each time the quick window is shown again; returns a function that stops it. */
  onQuickShown: (fn: () => void): (() => void) => {
    const listener = () => fn();
    ipcRenderer.on('yumakbot:quick-shown', listener);
    return () => ipcRenderer.removeListener('yumakbot:quick-shown', listener);
  },
  /** Calls `fn` when the menu bar's Settings item is chosen; returns a function that stops it. */
  onOpenSettings: (fn: () => void): (() => void) => {
    const listener = () => fn();
    ipcRenderer.on('yumakbot:open-settings', listener);
    return () => ipcRenderer.removeListener('yumakbot:open-settings', listener);
  },
});
