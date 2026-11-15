import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** A choice button; `check` shows a tick box for questions with several answers. */
export function Chip({
  on,
  check = false,
  onClick,
  children,
}: {
  on: boolean;
  check?: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm transition-colors hover:bg-accent',
        on && 'border-[var(--brand)]/60 bg-[var(--brand)]/10 hover:bg-[var(--brand)]/15',
      )}
    >
      {check && (
        <span
          aria-hidden
          className={cn(
            'flex size-4 shrink-0 items-center justify-center rounded-[5px] border',
            on && 'border-[var(--brand)] bg-[var(--brand)] text-white',
          )}
        >
          {on && <Check className="size-3" strokeWidth={3} />}
        </span>
      )}
      {children}
    </button>
  );
}
