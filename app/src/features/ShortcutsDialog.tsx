import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useT, type MessageKey } from '@/i18n';
import { desktop } from '@/lib/desktop';
import { shortcutLabel } from '@/lib/quick';
import { useSendKey } from '@/lib/sendKey';
import { useUi } from '@/lib/store';

const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);
const MOD = mac ? '⌘' : 'Ctrl';

/** ⌘/ / Ctrl+/: the keys the app answers to, in one list. */
export function ShortcutsDialog() {
  const t = useT();
  const open = useUi((s) => s.shortcutsOpen);
  const setOpen = useUi((s) => s.setShortcutsOpen);
  const sendKey = useSendKey((s) => s.key);
  // The desktop app's global shortcut for the quick window, when it got one.
  const [quickKey, setQuickKey] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    void desktop
      ?.quickKey?.()
      .then(setQuickKey)
      .catch(() => {});
  }, [open]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key === '/') {
        e.preventDefault();
        setOpen(!useUi.getState().shortcutsOpen);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);
  const rows: [string[], MessageKey][] = [
    [[MOD, 'K'], 'shortcuts.search'],
    [[MOD, 'F'], 'shortcuts.find'],
    [[MOD, 'Shift', 'N'], 'shortcuts.newThread'],
    [[MOD, '1–9'], 'shortcuts.bots'],
    [[MOD, 'Shift', '[ ]'], 'shortcuts.cycleBots'],
    [[MOD, ','], 'shortcuts.settings'],
    [[MOD, '/'], 'shortcuts.list'],
    [sendKey === 'enter' ? ['Enter'] : [MOD, 'Enter'], 'shortcuts.send'],
    [sendKey === 'enter' ? ['Shift', 'Enter'] : ['Enter'], 'shortcuts.newline'],
    [['/'], 'shortcuts.commands'],
    [['$'], 'shortcuts.skills'],
    [['Esc'], 'shortcuts.escape'],
    ...(quickKey ? [[shortcutLabel(quickKey, mac), 'shortcuts.quick'] as [string[], MessageKey]] : []),
  ];
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="rounded-3xl sm:max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{t('shortcuts.title')}</DialogTitle>
        </DialogHeader>
        <dl className="divide-y text-sm">
          {rows.map(([keys, label]) => (
            <div key={label} className="flex items-center justify-between gap-4 py-2">
              <dt className="text-muted-foreground">{t(label)}</dt>
              <dd className="flex shrink-0 gap-1">
                {keys.map((k) => (
                  <kbd
                    key={k}
                    className="min-w-6 rounded-md border bg-secondary px-1.5 py-0.5 text-center font-mono text-xs"
                  >
                    {k}
                  </kbd>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
