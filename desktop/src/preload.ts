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
  /** Calls `fn` when the menu bar's Settings item is chosen; returns a function that stops it. */
  onOpenSettings: (fn: () => void): (() => void) => {
    const listener = () => fn();
    ipcRenderer.on('yumakbot:open-settings', listener);
    return () => ipcRenderer.removeListener('yumakbot:open-settings', listener);
  },
});
