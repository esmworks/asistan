import { create } from 'zustand';

/** Interface sizes offered, as a share of the normal size. */
export const ZOOMS = [0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;
const KEY = 'leafbot.zoom';

function read(): number {
  try {
    const v = Number(localStorage.getItem(KEY));
    return (ZOOMS as readonly number[]).includes(v) ? v : 1;
  } catch {
    return 1;
  }
}

function apply(zoom: number) {
  // The whole page scales: text, spacing and the parts drawn in pixels alike.
  document.documentElement.style.zoom = zoom === 1 ? '' : String(zoom);
}

/** The interface size of this device; a large screen and a laptop may want different ones. */
export const useZoom = create<{ zoom: number; setZoom(z: number): void }>((set) => {
  const zoom = read();
  apply(zoom);
  return {
    zoom,
    setZoom: (z) => {
      try {
        localStorage.setItem(KEY, String(z));
      } catch {
        // Held for this page.
      }
      apply(z);
      set({ zoom: z });
    },
  };
});
