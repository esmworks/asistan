import type { TurnChangeItem } from '@leafbot/shared';

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

// Shared with the web app, which offers the same rehearsal.
export { clock, rehearsalSeconds, startedBySomething, triggerKey } from '@leafbot/app/src/lib/rehearsal';
