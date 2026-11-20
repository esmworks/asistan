import type { Rehearsal, Routine, TurnChangeItem } from '@yumakbot/shared';

/**
 * What taking a turn back sorts into: changes put back as they are, those that need the bot's
 * owner, and those nobody can put back (too large to keep, or deleted words that are not kept).
 */
export function undoGroups(items: TurnChangeItem[]) {
  return {
    will: items.filter((i) => !i.reason && !i.needsOwner),
    owner: items.filter((i) => !i.reason && i.needsOwner),
    kept: items.filter((i) => i.reason),
  };
}

/** How many changes a finished undo put back, for the note that follows it. */
export const restoredCount = (items: TurnChangeItem[]) =>
  items.filter((i) => i.outcome === 'restored').length;

/** The catalog key naming what started a run; anything unknown reads as "by hand or from a script". */
export const triggerKey = (trigger: string | null) =>
  trigger === 'watch' || trigger === 'webhook' || trigger === 'email' || trigger === 'whatsapp'
    ? (`rehearsal.trigger.${trigger}` as const)
    : ('rehearsal.trigger.manual' as const);

/** Whether anything starts the routine besides its schedule, so a replay is worth offering. */
export const startedBySomething = (
  r: Pick<
    Routine,
    'watchUrl' | 'check' | 'webhookToken' | 'emailTrigger' | 'whatsappGroup' | 'whatsappPeople'
  >,
) =>
  !!r.watchUrl || !!r.check || !!r.webhookToken || r.emailTrigger || !!r.whatsappGroup || !!r.whatsappPeople;

/** Whole seconds a rehearsal took; null while it is still going. */
export const rehearsalSeconds = (r: Pick<Rehearsal, 'startedAt' | 'finishedAt'>) =>
  r.finishedAt ? Math.max(0, Math.round((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000)) : null;

/** Seconds as m:ss. */
export const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
