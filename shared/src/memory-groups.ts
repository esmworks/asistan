import type { Bot, Memory } from './schemas.js';

/** One bot's own notes, as the memory screen lists them. */
export interface BotNoteGroup {
  botId: string;
  /** The bot's name; null when no bot with that id is known any more. */
  name: string | null;
  /** The bot is archived: no other bot sees these notes, so they only wait to be deleted. */
  archived: boolean;
  notes: Memory[];
}

/**
 * The bots' own notes grouped by bot: bots in use first in their sidebar order, then archived
 * ones, then any whose bot is unknown. A long list left by an import can then be read and cleared
 * one bot at a time.
 */
export function botNoteGroups(
  memory: Memory[],
  bots: Pick<Bot, 'id' | 'name'>[],
  archived: Pick<Bot, 'id' | 'name'>[],
): BotNoteGroup[] {
  const byBot = new Map<string, Memory[]>();
  for (const m of memory) {
    if (m.scope !== 'bot' || !m.botId) continue;
    const list = byBot.get(m.botId) ?? [];
    list.push(m);
    byBot.set(m.botId, list);
  }
  const groups: BotNoteGroup[] = [];
  const take = (id: string, name: string | null, isArchived: boolean) => {
    const notes = byBot.get(id);
    if (!notes) return;
    groups.push({ botId: id, name, archived: isArchived, notes });
    byBot.delete(id);
  };
  for (const b of bots) take(b.id, b.name, false);
  for (const b of archived) take(b.id, b.name, true);
  for (const id of [...byBot.keys()]) take(id, null, false);
  return groups;
}
