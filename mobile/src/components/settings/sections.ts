import type { IconName } from '@/components/page';

/** The settings sections in the order the list shows them. */
export const SECTIONS = [
  { id: 'profile', icon: 'user' },
  { id: 'general', icon: 'sliders' },
  { id: 'connection', icon: 'link-2' },
  { id: 'channels', icon: 'message-circle' },
  { id: 'permissions', icon: 'shield' },
  { id: 'vault', icon: 'key' },
  { id: 'memory', icon: 'cpu' },
  { id: 'routines', icon: 'clock' },
  { id: 'skills', icon: 'star' },
  { id: 'groups', icon: 'folder' },
  { id: 'import', icon: 'download' },
  { id: 'usage', icon: 'bar-chart-2' },
  { id: 'about', icon: 'info' },
] as const satisfies readonly { id: string; icon: IconName }[];

export type SectionId = (typeof SECTIONS)[number]['id'];

export function isSection(id: string | undefined): id is SectionId {
  return SECTIONS.some((s) => s.id === id);
}
