import { PHONE, useMedia, useViewportWidth } from '@/lib/media';
import { fitLayout, useUi } from '@/lib/store';

/** Whether this is a phone, the sidebar's width and whether the bot panel fits beside the chat. */
export function useLayout() {
  const phone = useMedia(PHONE);
  const viewport = useViewportWidth();
  const chosen = useUi((s) => s.sidebarWidth);
  const { sidebar, panelBeside } = fitLayout(viewport, chosen);
  return { phone, sidebar, panelBeside: panelBeside && !phone };
}
