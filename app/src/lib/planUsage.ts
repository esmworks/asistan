import type { PlanTone, PlanWindow } from '@leafbot/shared';
import type { useT } from '@/i18n';

const PLAN_LABELS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'] as const;

/** A plan window's bar colour by how its use reads, the same in Settings and beside the chat. */
export const PLAN_TONE_BAR: Record<PlanTone, string> = {
  fine: 'bg-emerald-500',
  ahead: 'bg-amber-500',
  near: 'bg-red-500',
};

/** The same, for a mark drawn in the text colour. */
export const PLAN_TONE_TEXT: Record<PlanTone, string> = {
  fine: 'text-emerald-600 dark:text-emerald-400',
  ahead: 'text-amber-600 dark:text-amber-400',
  near: 'text-red-600 dark:text-red-400',
};

/** A plan window's name: the account's own, a known one translated, else its kind as given. */
export function planLabel(w: PlanWindow, t: ReturnType<typeof useT>): string {
  if (w.label) return w.label;
  const known = PLAN_LABELS.find((k) => k === w.kind);
  return known ? t(`usage.plan.${known}`) : w.kind;
}
