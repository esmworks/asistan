import { BRAND_COLOR, PROFILE_HELP, type ObjectAvatar, type ProfileHelp } from '@leafbot/shared';
import type { T } from '@/i18n';

/** Roles offered for "What do you do?"; the chosen labels become the occupation text. */
export const ROLES = [
  'owner',
  'freelance',
  'office',
  'engineering',
  'design',
  'sales',
  'manager',
  'teacher',
  'student',
] as const;
export type Role = (typeof ROLES)[number];

/** A general bot, plus one bot for each kind of work the person can ask help with. */
export type StarterId = 'general' | ProfileHelp;

const LOOK: Record<StarterId, { object: ObjectAvatar; color: string }> = {
  general: { object: 'circle', color: BRAND_COLOR },
  research: { object: 'diamond', color: '#0891b2' },
  writing: { object: 'leaf', color: '#4f6bed' },
  documents: { object: 'square', color: '#0d9488' },
  web: { object: 'cloud', color: '#7c5cff' },
  planning: { object: 'pill', color: '#f97316' },
  code: { object: 'hexagon', color: '#64748b' },
  learning: { object: 'star', color: '#d4a017' },
};

/** Every starter: the general bot first, then one per kind of work. */
export const STARTERS: readonly StarterId[] = ['general', ...PROFILE_HELP];

/** The starters a new bot may begin from: those not already among the person's bots by name. */
export function availableStarters(t: T, names: readonly string[]): StarterId[] {
  const taken = new Set(names.map((n) => n.trim().toLocaleLowerCase()));
  return STARTERS.filter((id) => !taken.has(starterBot(id, t).name.trim().toLocaleLowerCase()));
}

/** The general bot first, then one bot per chosen kind of work, in the order they are offered. */
export function suggestedStarters(helpWith: readonly ProfileHelp[]): StarterId[] {
  return ['general', ...PROFILE_HELP.filter((h) => helpWith.includes(h))];
}

export interface StarterBot {
  name: string;
  description: string;
  instructions: string;
  avatar: string;
  color: string;
}

/** The bot to create for a starter, written in the current language. */
export function starterBot(id: StarterId, t: T): StarterBot {
  return {
    name: t(`starter.${id}.name`),
    description: t(`starter.${id}.description`),
    instructions: t(`starter.${id}.instructions`),
    avatar: `object:${LOOK[id].object}`,
    color: LOOK[id].color,
  };
}
