import { create } from 'zustand';
import { INTL_LOCALE, type Locale } from '@yumakbot/shared';

const RATE_KEY = 'yumakbot.speech.rate';
/** Reading speeds offered; 1 is the voice's own. */
export const SPEECH_RATES = [0.75, 1, 1.25, 1.5, 2] as const;

function readRate(): number {
  try {
    const v = Number(localStorage.getItem(RATE_KEY));
    return (SPEECH_RATES as readonly number[]).includes(v) ? v : 1;
  } catch {
    return 1;
  }
}

/** Which message is being read aloud, if any, and how fast this device reads. */
export const useSpeech = create<{ speaking: string | null; rate: number; setRate(rate: number): void }>(
  (set) => ({
    speaking: null,
    rate: readRate(),
    setRate: (rate) => {
      try {
        localStorage.setItem(RATE_KEY, String(rate));
      } catch {
        // Kept for this page when storage is off.
      }
      set({ rate });
    },
  }),
);

export const speechSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window;

/** Markdown as it sounds: code blocks and marks dropped, links read by their text. */
export function speakable(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]{0,3}(#{1,6}|>|[-*+]|\d+[.)])[ \t]+/gm, '')
    .replace(/(\*\*|__|\*|_|~~)(.+?)\1/g, '$2')
    .replace(/\$\$([\s\S]*?)\$\$/g, '$1')
    .replace(/\|/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** Reads a message aloud with the system's voice for the language; again on the same one stops. */
export function toggleSpeech(id: string, markdown: string, locale: Locale) {
  if (!speechSupported()) return;
  const synth = window.speechSynthesis;
  const was = useSpeech.getState().speaking;
  synth.cancel();
  if (was === id) return useSpeech.setState({ speaking: null });
  const u = new SpeechSynthesisUtterance(speakable(markdown));
  u.lang = INTL_LOCALE[locale];
  u.rate = useSpeech.getState().rate;
  const voice = synth.getVoices().find((v) => v.lang.toLowerCase().startsWith(locale));
  if (voice) u.voice = voice;
  const done = () => {
    if (useSpeech.getState().speaking === id) useSpeech.setState({ speaking: null });
  };
  u.onend = done;
  u.onerror = done;
  useSpeech.setState({ speaking: id });
  synth.speak(u);
}
