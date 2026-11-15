import type { BotSummary } from '@yumakbot/shared';
import { useEffect } from 'react';
import { create } from 'zustand';
import { desktop } from './desktop';
import { useLayout } from './layout';
import { useSummaries } from './queries';
import { useUi } from './store';

const KEY = 'yumakbot.seen';

/** Per bot, the time of the latest reply the person has seen on this device ('' for none). */
export type Seen = Record<string, string>;

function read(): Seen | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    return Object.fromEntries(Object.entries(v).filter(([, at]) => typeof at === 'string')) as Seen;
  } catch {
    return null;
  }
}

function write(seen: Seen) {
  try {
    localStorage.setItem(KEY, JSON.stringify(seen));
  } catch {
    // Private windows may refuse; the marks hold for this page.
  }
}

/**
 * Whether the bot wrote after the person last looked. A device that never kept marks (`seen`
 * null) shows nothing as unread; a bot it has no mark for counts every reply.
 */
export function isUnread(summary: Pick<BotSummary, 'botId' | 'repliedAt'>, seen: Seen | null): boolean {
  if (!seen || !summary.repliedAt) return false;
  return summary.repliedAt > (seen[summary.botId] ?? '');
}

/**
 * The marks after a summary update: a device's first list is taken as read, so the badge starts
 * from what arrives next rather than from the whole history; bots no longer listed are dropped.
 */
export function nextSeen(
  seen: Seen | null,
  summaries: readonly Pick<BotSummary, 'botId' | 'repliedAt'>[],
): Seen {
  if (!seen) return Object.fromEntries(summaries.map((s) => [s.botId, s.repliedAt ?? '']));
  const listed = new Set(summaries.map((s) => s.botId));
  return Object.fromEntries(Object.entries(seen).filter(([id]) => listed.has(id)));
}

/** A count fit for a badge: whole, not negative, at most 999. */
export function badgeCount(n: number): number {
  return Number.isFinite(n) ? Math.min(999, Math.max(0, Math.trunc(n))) : 0;
}

/** The page title with the number of bots waiting to be read in front. */
export function titleWithCount(base: string, count: number): string {
  return count > 0 ? `(${badgeCount(count)}) ${base}` : base;
}

export const useSeen = create<{
  seen: Seen | null;
  sync(summaries: readonly BotSummary[]): void;
  markSeen(botId: string, at: string): void;
  markUnread(botId: string): void;
  markAllSeen(summaries: readonly BotSummary[]): void;
}>((set, get) => ({
  seen: read(),
  sync: (summaries) => {
    const before = get().seen;
    const seen = nextSeen(before, summaries);
    if (before && Object.keys(before).length === Object.keys(seen).length) return;
    write(seen);
    set({ seen });
  },
  markSeen: (botId, at) => {
    const seen = get().seen ?? {};
    if ((seen[botId] ?? '') >= at) return;
    const next = { ...seen, [botId]: at };
    write(next);
    set({ seen: next });
  },
  markAllSeen: (summaries) => {
    const next = { ...(get().seen ?? {}) };
    for (const s of summaries)
      if (s.repliedAt && (next[s.botId] ?? '') < s.repliedAt) next[s.botId] = s.repliedAt;
    write(next);
    set({ seen: next });
  },
  markUnread: (botId) => {
    const next = { ...(get().seen ?? {}), [botId]: '' };
    write(next);
    set({ seen: next });
  },
}));

/** Whether the person can see the page right now. */
function looking() {
  return document.visibilityState === 'visible' && document.hasFocus();
}

/**
 * Marks the open bot's replies as read while the person looks at its chat, and puts the number
 * of bots with unread replies in the page title and on the desktop app's icon.
 */
export function useUnreadTracking() {
  const { data: summaries } = useSummaries();
  const botId = useUi((s) => s.botId);
  const phonePane = useUi((s) => s.phonePane);
  const { phone } = useLayout();
  const seen = useSeen((s) => s.seen);
  const chatShown = !!botId && (!phone || phonePane === 'chat');

  useEffect(() => {
    if (summaries) useSeen.getState().sync(summaries);
  }, [summaries]);

  useEffect(() => {
    const mark = () => {
      if (!chatShown || !looking()) return;
      const at = summaries?.find((s) => s.botId === botId)?.repliedAt;
      if (at) useSeen.getState().markSeen(botId, at);
    };
    mark();
    window.addEventListener('focus', mark);
    document.addEventListener('visibilitychange', mark);
    return () => {
      window.removeEventListener('focus', mark);
      document.removeEventListener('visibilitychange', mark);
    };
  }, [summaries, botId, chatShown]);

  const busy = !!summaries?.some((s) => s.state === 'running' || s.state === 'queued');
  useEffect(() => {
    void desktop?.setBusy?.(busy);
  }, [busy]);

  const count = summaries?.filter((s) => isUnread(s, seen)).length ?? 0;
  useEffect(() => {
    document.title = titleWithCount('YumakBot', count);
    void desktop?.setUnread?.(badgeCount(count));
  }, [count]);
}
