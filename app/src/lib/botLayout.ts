import type { Bot, BotMove } from '@leafbot/shared';

/** A sidebar section: the pinned bots, a group's id, or the ungrouped bots. */
export type SectionKey = string;
export const PINNED: SectionKey = 'pinned';
export const UNGROUPED: SectionKey = 'ungrouped';

export const sectionOf = (b: Bot): SectionKey => (b.pinned ? PINNED : (b.groupId ?? UNGROUPED));

export function moveTo(section: SectionKey, beforeId: string | null): BotMove {
  if (section === PINNED) return { pinned: true, groupId: null, beforeId };
  return { pinned: false, groupId: section === UNGROUPED ? null : section, beforeId };
}

/** True when the move would leave the bot where it is. */
export function isNoop(bots: Bot[], id: string, to: BotMove): boolean {
  const bot = bots.find((b) => b.id === id);
  if (!bot || bot.pinned !== to.pinned || (!to.pinned && bot.groupId !== to.groupId)) return false;
  const section = bots.filter((b) => sectionOf(b) === sectionOf(bot));
  const next = section[section.findIndex((b) => b.id === id) + 1]?.id ?? null;
  return to.beforeId === id || to.beforeId === next;
}

/** The bot list as the server orders it after the move, to show the move before it answers. */
export function applyMove(bots: Bot[], id: string, to: BotMove): Bot[] {
  const bot = bots.find((b) => b.id === id);
  if (!bot) return bots;
  const moved: Bot = { ...bot, pinned: to.pinned, groupId: to.pinned ? bot.groupId : to.groupId };
  const key = sectionOf(moved);
  const section = bots.filter((b) => b.id !== id && sectionOf(b) === key);
  const at = to.beforeId ? section.findIndex((b) => b.id === to.beforeId) : -1;
  section.splice(at < 0 ? section.length : at, 0, moved);
  const position = new Map(section.map((b, i) => [b.id, i]));
  return bots
    .map((b) => (b.id === id ? moved : b))
    .map((b) => (position.has(b.id) ? { ...b, position: position.get(b.id)! } : b))
    .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
}
