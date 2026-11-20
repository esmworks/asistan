import type { Bot, Group } from '@yumakbot/shared';
import { useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { useGroups } from './queries';

/**
 * Whether a bot starts no work now, and why: paused itself, or with its group. A bot paused both
 * ways names itself, since resuming the group alone would not let it work.
 */
export function usePaused(bot: Pick<Bot, 'pausedAt' | 'groupId'>): {
  paused: boolean;
  group: Group | null;
} {
  const { data: groups = [] } = useGroups();
  if (bot.pausedAt) return { paused: true, group: null };
  const group = groups.find((g) => g.id === bot.groupId && g.pausedAt) ?? null;
  return { paused: !!group, group };
}

/** Pauses or resumes a bot, a group or every bot, and refreshes what shows it. */
export function usePauseActions() {
  const qc = useQueryClient();
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['bots'] }),
      qc.invalidateQueries({ queryKey: ['groups'] }),
      qc.invalidateQueries({ queryKey: ['summaries'] }),
    ]);
  return {
    bot: (id: string, paused: boolean) => api.pauseBot(id, paused).then(refresh),
    group: (id: string, paused: boolean) => api.pauseGroup(id, paused).then(refresh),
    all: (paused: boolean) => api.pauseAllBots(paused).then(async (r) => (await refresh(), r)),
  };
}
