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

/** The server's Slack app: its app-level token (Socket Mode) and its bot token. */
export const SlackConnect = z.object({
  appToken: z.string().trim().min(1).max(500),
  botToken: z.string().trim().min(1).max(500),
  /** The bot that answers when a message names none. */
  botId: z.string().min(1).nullable(),
});
export type SlackConnect = z.infer<typeof SlackConnect>;

export const SlackUpdate = z.object({ botId: z.string().min(1).nullable() });

/** The server's Slack app, as those who look after the server see it. Never the tokens. */
export interface SlackStatus {
  /** Tokens are saved and the server listens. */
  connected: boolean;
  workspace: { id: string; name: string } | null;
  /** The Slack app's bot user, as people mention it. */
  botUser: string | null;
  botId: string | null;
  /** The people linked to a Slack account. */
  people: { userId: string; name: string; slackName: string }[];
  /** Why it stopped working, in Slack's words; null while it works. */
  error: string | null;
}

/** One person's link to Slack. */
export interface SlackLink {
  /** The server has a Slack app. */
  available: boolean;
  workspace: string | null;
  /** The Slack account linked to them; null when none. */
  linked: { name: string } | null;
  /** The code to send the Slack app as `link <code>`; null when none is waiting. */
  code: string | null;
  codeUntil: string | null;
}

/**
 * What to paste into Slack's "Create an app from a manifest": Socket Mode (no public address),
 * the events and permissions the server uses, and the buttons on cards.
 */
export function slackManifest(name: string): string {
  const display = name.trim().slice(0, 35) || 'Yumak Bot';
  return JSON.stringify(
    {
      display_information: { name: display },
      features: {
        app_home: { messages_tab_enabled: true, messages_tab_read_only_enabled: false },
        bot_user: { display_name: display, always_online: true },
      },
      oauth_config: {
        scopes: {
          bot: [
            'app_mentions:read',
            'channels:history',
            'groups:history',
            'im:history',
            'mpim:history',
            'chat:write',
            'files:read',
            'files:write',
            'reactions:write',
            'users:read',
          ],
        },
      },
      settings: {
        event_subscriptions: {
          bot_events: ['app_mention', 'message.channels', 'message.groups', 'message.im', 'message.mpim'],
        },
        interactivity: { is_enabled: true },
        org_deploy_enabled: false,
        socket_mode_enabled: true,
        token_rotation_enabled: false,
      },
    },
    null,
    2,
  );
}
