import { useEffect, useLayoutEffect, type RefObject } from 'react';

/**
 * Grows a text box with what is written in it, up to `max` pixels. A box that is not on screen
 * yet (the conversation pane behind the list on a phone) is measured once it shows, instead of
 * keeping the zero height it measured while hidden.
 */
export function useFitHeight(ref: RefObject<HTMLTextAreaElement | null>, text: string, max = 240) {
  useLayoutEffect(() => fit(ref.current, max), [ref, text, max]);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let width = el.clientWidth;
    const watch = new ResizeObserver(() => {
      // Only a new width (shown, turned sideways) changes the height the text needs.
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit(el, max);
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, [ref, max]);
}

function fit(el: HTMLTextAreaElement | null, max: number) {
  // A hidden box measures zero; its own size stands until it shows.
  if (!el || !el.getClientRects().length) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, max)}px`;
}
