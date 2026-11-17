/**
 * The quick view: what the bots wait on the person for, in a small window the desktop app opens
 * with a global shortcut, answered from the keyboard.
 */

/** Whether this page is the desktop app's quick window (`?quick=1`). */
export function isQuickView(search = typeof location === 'undefined' ? '' : location.search): boolean {
  return new URLSearchParams(search).get('quick') === '1';
}

/** What a card lets the person do in place: allow a tool, pick an option, or only open the chat. */
export type QuickCard = { kind: 'tool' } | { kind: 'question'; options: number } | { kind: 'open' };

export type QuickAction =
  | { type: 'move'; by: 1 | -1 }
  | { type: 'allow' }
  | { type: 'deny' }
  | { type: 'choose'; index: number }
  | { type: 'write' }
  | { type: 'open' }
  | { type: 'close' };

/**
 * The key a person pressed, read for the selected card: ↑/↓ or K/J move, 1–9 answer, R writes an
 * answer, O or Enter opens the conversation, Esc closes. Keys held with ⌘, Ctrl or Alt are left
 * to the system.
 */
export function quickAction(
  e: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean },
  card: QuickCard | null,
): QuickAction | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (key === 'Escape') return { type: 'close' };
  if (key === 'ArrowDown' || key === 'j') return { type: 'move', by: 1 };
  if (key === 'ArrowUp' || key === 'k') return { type: 'move', by: -1 };
  if (!card) return null;
  if (key === 'o' || key === 'Enter') return { type: 'open' };
  if (card.kind === 'tool') {
    if (key === '1') return { type: 'allow' };
    if (key === '2') return { type: 'deny' };
    return null;
  }
  if (card.kind === 'question') {
    if (key === 'r') return { type: 'write' };
    const n = /^[1-9]$/.test(key) ? Number(key) - 1 : -1;
    if (n >= 0 && n < card.options) return { type: 'choose', index: n };
  }
  return null;
}

/** An Electron accelerator as the keys read on this system: `CommandOrControl+Shift+Space` → `⌘ ⇧ Space` on a Mac. */
export function shortcutLabel(accelerator: string, mac: boolean): string[] {
  const names: Record<string, string> = mac
    ? {
        Alt: '⌥',
        Option: '⌥',
        Control: '⌃',
        Ctrl: '⌃',
        Command: '⌘',
        Cmd: '⌘',
        CommandOrControl: '⌘',
        CmdOrCtrl: '⌘',
        Shift: '⇧',
      }
    : {
        Control: 'Ctrl',
        Option: 'Alt',
        Command: 'Ctrl',
        Cmd: 'Ctrl',
        CommandOrControl: 'Ctrl',
        CmdOrCtrl: 'Ctrl',
      };
  return accelerator.split('+').map((k) => names[k] ?? k);
}
