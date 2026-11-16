import { z } from 'zod';

/**
 * A Telegram bot token as BotFather gives it (`123456:ABC…`); the whole reply BotFather sends can
 * be pasted, the token is found in it. Null when there is none.
 */
export function telegramToken(raw: string): string | null {
  return raw.match(/\b\d{5,16}:[A-Za-z0-9_-]{30,64}\b/)?.[0] ?? null;
}

export const TelegramConnect = z.object({ token: z.string().trim().min(1).max(4000) });
export const TelegramUpdate = z.object({
  /** Routine reports and "needs you" notes from the bot's other conversations come here too. */
  notices: z.boolean(),
});

/** One bot's own Telegram bot, as the app shows it. Never the token. */
export interface TelegramStatus {
  /** A token is saved and the server listens for messages. */
  connected: boolean;
  bot: { username: string; name: string } | null;
  /** The one Telegram account allowed to write; null until someone pairs. */
  owner: { name: string } | null;
  /** Opens the bot's chat with the pairing code; null when no pairing is under way. */
  pairLink: string | null;
  /** The pairing link as a QR code (a PNG data URL), to scan with the phone. */
  pairQr: string | null;
  pairUntil: string | null;
  notices: boolean;
  /** Why it stopped working, in Telegram's words; null while it works. */
  error: string | null;
}

/** `own`: the person's own number, written to in "Message yourself". `separate`: a second number. */
export const WhatsAppMode = z.enum(['own', 'separate']);
export type WhatsAppMode = z.infer<typeof WhatsAppMode>;

/** A phone number with its country code, digits only. */
export const PhoneNumber = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s()+-]/g, '').replace(/^00/, ''))
  .pipe(z.string().regex(/^[1-9]\d{6,14}$/, 'validation.phone'));

export const WhatsAppSet = z.object({
  mode: WhatsAppMode,
  /** The person's own number; with a separate bot number, only this number is read. */
  phone: PhoneNumber,
  /** The bot its messages go to first; `/bot <name>` changes it from WhatsApp. */
  botId: z.string().min(1).nullable(),
  notices: z.boolean().default(true),
});
export type WhatsAppSet = z.infer<typeof WhatsAppSet>;

export interface WhatsAppStatus {
  /** `off`: not set up. `linking`: waiting for the QR code to be scanned. */
  state: 'off' | 'linking' | 'connecting' | 'connected' | 'error';
  mode: WhatsAppMode | null;
  phone: string | null;
  botId: string | null;
  notices: boolean;
  /** The linked account's number, once linked. */
  linked: string | null;
  /** The QR code to scan while linking, as a PNG data URL. */
  qr: string | null;
  error: string | null;
}
