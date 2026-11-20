import { create } from 'zustand';

/** How the sidebar lists bots: with their last message, or one short line each. */
export type Density = 'comfortable' | 'compact';
const KEY = 'leafbot.density';

function read(): Density {
  try {
    return localStorage.getItem(KEY) === 'compact' ? 'compact' : 'comfortable';
  } catch {
    return 'comfortable';
  }
}

/** Kept per device: a small laptop screen may want more bots in view than a large one. */
export const useDensity = create<{ density: Density; set(d: Density): void }>((set) => ({
  density: read(),
  set: (density) => {
    try {
      localStorage.setItem(KEY, density);
    } catch {
      // Held for this page.
    }
    set({ density });
  },
}));

/** How wide the conversation column is: the reading width, wider, or the whole window. */
export type ChatWidth = 'normal' | 'wide' | 'full';
const WIDTH_KEY = 'leafbot.chatWidth';
const WIDTHS: Record<ChatWidth, [string, string]> = {
  normal: ['860px', '730px'],
  wide: ['1180px', '1000px'],
  full: ['100%', '92%'],
};

function readWidth(): ChatWidth {
  try {
    const v = localStorage.getItem(WIDTH_KEY);
    return v === 'wide' || v === 'full' ? v : 'normal';
  } catch {
    return 'normal';
  }
}

function applyWidth(w: ChatWidth) {
  const [column, bubble] = WIDTHS[w];
  document.documentElement.style.setProperty('--chat-width', column);
  document.documentElement.style.setProperty('--bubble-width', bubble);
}

/** Kept per device: a wide monitor can show long tables and code without wrapping. */
export const useChatWidth = create<{ width: ChatWidth; set(w: ChatWidth): void }>((set) => {
  const width = readWidth();
  if (typeof document !== 'undefined') applyWidth(width);
  return {
    width,
    set: (w) => {
      try {
        localStorage.setItem(WIDTH_KEY, w);
      } catch {
        // Held for this page.
      }
      applyWidth(w);
      set({ width: w });
    },
  };
});

/** The interface's typeface: the bundled one, the system's own, or a serif for long reading. */
export type FontChoice = 'default' | 'system' | 'serif';
const FONT_KEY = 'leafbot.font';
const FONTS: Record<FontChoice, string | null> = {
  default: null,
  system: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
  serif: "ui-serif, 'Iowan Old Style', 'Palatino Linotype', Georgia, serif",
};

function readFont(): FontChoice {
  try {
    const v = localStorage.getItem(FONT_KEY);
    return v === 'system' || v === 'serif' ? v : 'default';
  } catch {
    return 'default';
  }
}

function applyFont(f: FontChoice) {
  const value = FONTS[f];
  if (value) document.documentElement.style.setProperty('--font-sans', value);
  else document.documentElement.style.removeProperty('--font-sans');
}

/** Kept per device, like the theme and the zoom. */
export const useFont = create<{ font: FontChoice; set(f: FontChoice): void }>((set) => {
  const font = readFont();
  if (typeof document !== 'undefined') applyFont(font);
  return {
    font,
    set: (f) => {
      try {
        localStorage.setItem(FONT_KEY, f);
      } catch {
        // Held for this page.
      }
      applyFont(f);
      set({ font: f });
    },
  };
});
