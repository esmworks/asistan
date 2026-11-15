import type { BotSummary, TurnState } from '@yumakbot/shared';
import { useBrowsers } from './browser';
import { useSummaries } from './queries';
import { useUi } from './store';

/** What a bot is doing right now, as its avatar shows it. */
export type BotActivity = 'idle' | 'queued' | 'thinking' | 'writing' | 'browsing' | 'waiting';

export interface ActivityInput {
  state: TurnState;
  pendingApprovals: number;
  /** Text of the current answer is arriving right now (not paused for a tool). */
  streaming: boolean;
  /** The bot is driving its browser. */
  browsing: boolean;
}

/** Waiting on a person wins over everything; then whatever the running turn is busy with. */
export function activityOf({ state, pendingApprovals, streaming, browsing }: ActivityInput): BotActivity {
  if (pendingApprovals > 0 || state === 'waiting') return 'waiting';
  if (state === 'queued') return 'queued';
  if (state !== 'running') return 'idle';
  if (browsing) return 'browsing';
  return streaming ? 'writing' : 'thinking';
}

/** The activity of a bot in one thread, from the live events; `fallback` is the state last fetched. */
export function useThreadActivity(
  botId: string,
  threadId: string | null | undefined,
  fallback: TurnState = 'idle',
  pendingApprovals = 0,
): BotActivity {
  const live = useUi((s) => (threadId ? s.states[threadId] : undefined));
  const streaming = useUi((s) => !!threadId && !!s.writing[threadId]);
  const browsing = useBrowsers((s) => s.states[botId]?.status === 'bot');
  return activityOf({ state: live ?? fallback, pendingApprovals, streaming, browsing });
}

/** The activity of a bot from its sidebar summary and the live events. */
export function useBotActivity(botId: string, summary?: BotSummary): BotActivity {
  return useThreadActivity(botId, summary?.threadId, summary?.state, summary?.pendingApprovals);
}

/** Same as useBotActivity, for places that have only the bot. */
export function useBotActivityById(botId: string): BotActivity {
  const { data } = useSummaries();
  return useBotActivity(
    botId,
    data?.find((s) => s.botId === botId),
  );
}
