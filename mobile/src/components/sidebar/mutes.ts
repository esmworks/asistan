/** Muted bots and until when (ms since the epoch); null keeps a bot muted until unmuted. */
export type Mutes = Record<string, number | null>;

/** Kept under the same key the web app uses, so a setting made elsewhere on this phone agrees. */
export const MUTED_KEY = 'leafbot.notify.muted';

/** Whether the bot is muted now; a mute whose time has passed no longer counts. */
export function isMuted(mutes: Mutes, botId: string, now = Date.now()): boolean {
  if (!(botId in mutes)) return false;
  const until = mutes[botId];
  return until === null || until === undefined || until > now;
}

/** The end of a mute for the choices the menu offers. */
export function muteUntil(choice: 'hour' | 'morning' | 'always', now = new Date()): number | null {
  if (choice === 'always') return null;
  if (choice === 'hour') return now.getTime() + 3_600_000;
  const morning = new Date(now);
  morning.setHours(8, 0, 0, 0);
  if (morning <= now) morning.setDate(morning.getDate() + 1);
  return morning.getTime();
}

/** The mutes with this bot muted until `until`; mutes that ran out are dropped on the way. */
export function withMute(mutes: Mutes, botId: string, until: number | null, now = Date.now()): Mutes {
  const kept = Object.fromEntries(Object.entries(mutes).filter(([id]) => isMuted(mutes, id, now)));
  return { ...kept, [botId]: until };
}

export function withoutMute(mutes: Mutes, botId: string): Mutes {
  return Object.fromEntries(Object.entries(mutes).filter(([id]) => id !== botId));
}
