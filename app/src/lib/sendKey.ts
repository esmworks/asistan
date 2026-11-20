import { create } from 'zustand';

/** What sends a message: Enter (Shift+Enter breaks the line), or ⌘/Ctrl+Enter (Enter breaks it). */
export type SendKey = 'enter' | 'mod';
const KEY = 'leafbot.sendKey';

/**
 * The choice kept on this device, or the device's own default: on a touch screen the keyboard's
 * Return breaks the line and the send button sends, as phone messaging apps do.
 */
function read(): SendKey {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {
    // Nothing kept: the device's default.
  }
  return saved === 'mod' || saved === 'enter' ? saved : defaultSendKey(touchScreen());
}

function touchScreen(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
}

export const defaultSendKey = (touch: boolean): SendKey => (touch ? 'mod' : 'enter');

/** Kept per device: a keyboard habit belongs to the computer, not to the server. */
export const useSendKey = create<{ key: SendKey; set(k: SendKey): void }>((set) => ({
  key: read(),
  set: (key) => {
    try {
      localStorage.setItem(KEY, key);
    } catch {
      // The choice holds for this page.
    }
    set({ key });
  },
}));

/** Whether this key press sends, and whether it breaks the line instead. */
export function keyAction(
  e: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; isComposing: boolean },
  mode: SendKey,
): 'send' | 'newline' | null {
  if (e.key !== 'Enter' || e.isComposing) return null;
  if (mode === 'enter') return e.shiftKey ? 'newline' : 'send';
  return e.metaKey || e.ctrlKey ? 'send' : 'newline';
}
