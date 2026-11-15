import { useSyncExternalStore } from 'react';

/**
 * A narrow screen, or a touch screen too short to fit the list beside the chat (a phone held
 * sideways): the list of bots and a chat take the whole screen in turn. Keep in step with the
 * `phone` variant in index.css.
 */
export const PHONE = '(max-width: 767px), (max-height: 499px) and (pointer: coarse)';

/** The window's width, kept current as it changes. */
export function useViewportWidth(): number {
  return useSyncExternalStore(
    (onChange) => {
      addEventListener('resize', onChange);
      return () => removeEventListener('resize', onChange);
    },
    () => innerWidth,
    () => 0,
  );
}

/** Whether a media query matches, kept current as the window changes size. */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => matchMedia(query).matches,
    () => false,
  );
}
