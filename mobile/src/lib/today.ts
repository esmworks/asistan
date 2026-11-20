import type { PersonInfo, Schedule } from '@yumakbot/shared';

export type Rhythm = 'daily' | 'weekdays' | 'weekly';

/** What the person has picked for a suggestion's schedule: a rhythm (none yet), a weekday and a clock time. */
export interface When {
  kind: Rhythm | '';
  day: number;
  time: string;
}

/** A time of day as the server stores it. */
export const isClockTime = (v: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

/** The rhythm a suggestion came with, or nothing picked when its requests had none. */
export function pickable(s: Schedule | null): When {
  if (s?.type === 'daily' || s?.type === 'weekdays') return { kind: s.type, day: 1, time: s.time };
  if (s?.type === 'weekly') return { kind: 'weekly', day: s.days[0] ?? 1, time: s.time };
  return { kind: '', day: 1, time: '09:00' };
}

/** The schedule a pick stands for; null until a rhythm and a valid time are chosen. */
export function scheduleOf(p: When): Schedule | null {
  if (!p.kind || !isClockTime(p.time)) return null;
  return p.kind === 'weekly'
    ? { type: 'weekly', days: [p.day], time: p.time }
    : { type: p.kind, time: p.time };
}

/** The name of the person with this id, `owner` for one with neither a display name nor a username. */
export function personNameOf(
  people: Pick<PersonInfo, 'id' | 'displayName' | 'username'>[],
  id: string | null | undefined,
  owner: string,
  fallback = '',
): string {
  const p = people.find((x) => x.id === id);
  return p ? p.displayName || p.username || owner : fallback;
}
