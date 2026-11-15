import { create } from 'zustand';

export type ThemeChoice = 'system' | 'light' | 'dark';
const KEY = 'yumakbot.theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');

function read(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  } catch {
    return 'system';
  }
}

function apply(choice: ThemeChoice) {
  const dark = choice === 'dark' || (choice === 'system' && media.matches);
  document.documentElement.classList.toggle('dark', dark);
  return dark;
}

interface ThemeState {
  choice: ThemeChoice;
  dark: boolean;
  setChoice(c: ThemeChoice): void;
}

export const useTheme = create<ThemeState>((set) => {
  const choice = read();
  return {
    choice,
    dark: apply(choice),
    setChoice: (c) => {
      try {
        localStorage.setItem(KEY, c);
      } catch {
        // ignore
      }
      set({ choice: c, dark: apply(c) });
    },
  };
});

media.addEventListener('change', () => {
  const { choice } = useTheme.getState();
  useTheme.setState({ dark: apply(choice) });
});
