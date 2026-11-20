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

/**
 * How a bot answers a chat given to it: `off` it does not; `draft` its answer waits on a card for
 * the person; `auto` it goes at once (up to a few an hour to one chat, then on a card).
 */
export const WhatsAppReplyMode = z.enum(['off', 'draft', 'auto']);
export type WhatsAppReplyMode = z.infer<typeof WhatsAppReplyMode>;

/**
 * A chat given to one bot: a person by their number (country code, digits only) or a group by its
 * address. That bot answers it, in a conversation of its own for that chat; a group is never
 * written to, the bot only tells the person what it was asked there.
 */
export const WhatsAppRoute = z.object({
  chat: z.string().regex(/^(\d{7,15}|[\w.-]{3,80}@g\.us)$/),
  botId: z.string().min(1),
  mode: WhatsAppReplyMode.default('draft'),
});
export type WhatsAppRoute = z.infer<typeof WhatsAppRoute>;

/** The bot that answers people with no chat given to a bot: the front door. */
export const WhatsAppDoor = z.object({
  botId: z.string().min(1),
  mode: WhatsAppReplyMode.default('draft'),
});
export type WhatsAppDoor = z.infer<typeof WhatsAppDoor>;

export const WhatsAppSet = z.object({
  mode: WhatsAppMode,
  /** The person's own number; with a separate bot number, only this number is read. */
  phone: PhoneNumber,
  /** The bot its messages go to first; `/bot <name>` changes it from WhatsApp. */
  botId: z.string().min(1).nullable(),
  notices: z.boolean().default(true),
  /**
   * Whether the bots may read the account's chats and draft messages in a conversation, as they
   * use any connected app; off, only the chats routines read are kept and seen. Left out, it
   * stays as it is.
   */
  chats: z.boolean().optional(),
  /**
   * Whether a bot at full access may send a message without its card: when the person asked for
   * the work, or as the answer to the chat whose reply woke it. Left out, it stays as it is.
   */
  autoSend: z.boolean().optional(),
  /** Chats given to bots. Left out, they stay as they are. */
  routes: z.array(WhatsAppRoute).max(200).optional(),
  /** The front door; null removes it. Left out, it stays as it is. */
  door: WhatsAppDoor.nullable().optional(),
});
export type WhatsAppSet = z.infer<typeof WhatsAppSet>;

export interface WhatsAppStatus {
  /** `off`: not set up. `linking`: waiting for the QR code to be scanned. */
  state: 'off' | 'linking' | 'connecting' | 'connected' | 'error';
  mode: WhatsAppMode | null;
  phone: string | null;
  botId: string | null;
  notices: boolean;
  /** Whether the bots may read the account's chats and draft messages in a conversation. */
  chats: boolean;
  /** Whether a bot at full access may send a message without its card. */
  autoSend: boolean;
  /** Chats given to bots, with the name the chat goes by here when it is known. */
  routes: (WhatsAppRoute & { name: string })[];
  door: WhatsAppDoor | null;
  /** The linked account's number, once linked. */
  linked: string | null;
  /** The QR code to scan while linking, as a PNG data URL. */
  qr: string | null;
  error: string | null;
}

/** A WhatsApp group the linked account is in, which a routine can follow. */
export interface WhatsAppGroup {
  /** Its address, `…@g.us`. */
  id: string;
  name: string;
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

/** The permissions the Slack app's bot token needs; the manifest asks for them and the server checks them. */
export const SLACK_BOT_SCOPES = [
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
] as const;

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
          bot: [...SLACK_BOT_SCOPES],
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

/** A Discord bot token as the developer portal shows it: three dot-separated parts. */
export function discordToken(raw: string): string | null {
  const token = raw.trim().replace(/^Bot\s+/i, '');
  return /^[\w-]{20,100}\.[\w-]{4,20}\.[\w-]{20,100}$/.test(token) ? token : null;
}

/** The server's Discord bot: its token from the developer portal, and the bot that answers there. */
export const DiscordConnect = z.object({
  token: z.string().trim().min(1).max(500),
  botId: z.string().min(1).nullable(),
});
export type DiscordConnect = z.infer<typeof DiscordConnect>;

/** Most roles one Discord server may list as allowed to use the bot. */
export const MAX_DISCORD_ROLES = 50;

export const DiscordUpdate = z.object({
  botId: z.string().min(1).nullable().optional(),
  /** One Discord server's roles whose members may use the bot; empty lets everyone there. */
  roles: z
    .object({
      serverId: z.string().regex(/^\d{1,25}$/),
      roleIds: z.array(z.string().regex(/^\d{1,25}$/)).max(MAX_DISCORD_ROLES),
    })
    .optional(),
});
export type DiscordUpdate = z.infer<typeof DiscordUpdate>;

/** One Discord server the bot is in, with who there may use it. */
export interface DiscordServer {
  id: string;
  name: string;
  /** Its roles, but `@everyone` and those of other apps. */
  roles: { id: string; name: string }[];
  /** The roles whose members may use the bot; empty: everyone there. */
  allowed: string[];
}

/** The server's Discord bot, as those who look after the server see it. Never the token. */
export interface DiscordStatus {
  /** A token is saved and the server listens. */
  connected: boolean;
  /** The bot's name in Discord, as people mention it. */
  botUser: string | null;
  /** The bot here that answers in Discord. */
  botId: string | null;
  /** Adds the Discord bot to a server, with the permissions it uses. */
  inviteUrl: string | null;
  servers: DiscordServer[];
  /**
   * Whether Discord gives the bot the text of every message (the Message Content intent). Off, it
   * reads only messages that mention it, so it misses the earlier lines of a channel.
   */
  messageContent: boolean;
  /** Why it stopped working, in Discord's words; null while it works. */
  error: string | null;
}

/**
 * What the Discord bot may do in a server: view channels, send messages (in threads too), embed
 * links, attach files, read message history and add reactions.
 */
export const DISCORD_PERMISSIONS = (
  (1n << 6n) |
  (1n << 10n) |
  (1n << 11n) |
  (1n << 14n) |
  (1n << 15n) |
  (1n << 16n) |
  (1n << 38n)
).toString();

/** The address that adds the Discord bot to a server. */
export const discordInviteUrl = (applicationId: string) =>
  `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(applicationId)}&scope=bot&permissions=${DISCORD_PERMISSIONS}`;
