import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { findBrowser } from './browser/find';
import { BASH_MAX_TIMEOUT_MS, stallLimits, type StallLimits } from './runtime/watchdog';

export interface Config {
  host: string;
  port: number;
  /**
   * Model services set in the server's environment, used while the settings name none: memory
   * search (`AI_EMBEDDINGS_*`), speech to text (`STT_*`) and text to speech (`TTS_*`).
   */
  aiEndpoints: Partial<Record<'embeddings' | 'stt' | 'tts', EnvAiEndpoint>>;
  /** Root for workspaces, the access key file and the embedded database. */
  dataDir: string;
  /** `postgres://...` for a real server; unset means embedded PGlite in `dataDir/db` (or memory in tests). */
  databaseUrl: string | null;
  /** In-memory database (tests). */
  memoryDb: boolean;
  accessKey: string | null;
  /** Extra hosts allowed in the Host header (besides loopback names). */
  allowedHosts: string[];
  /** Extra browser origins allowed (besides same-host). */
  allowedOrigins: string[];
  secureCookies: boolean;
  /**
   * A secret the reverse proxy in front of the server sends in the X-Yumakbot-Proxy header
   * (`YUMAKBOT_PROXY_SECRET`). Behind a proxy every request comes from the proxy's address, so the
   * sign-in limit would count all people as one; a request carrying the secret is trusted to name the
   * person's address in X-Forwarded-For. A secret rather than the proxy's address, because that
   * address depends on how Docker wires the networks, and other containers can reach the server too.
   */
  proxySecret: string | null;
  /**
   * The address other services reach this server at (`https://yumakbot.example.com`), for routine
   * webhooks and sign-in callbacks; null uses the address the page was opened at.
   */
  publicUrl: string | null;
  maxConcurrentTurns: number;
  /** Built UI to serve, if present. */
  appDir: string | null;
  engine: 'claude' | 'fake';
  claudeModel: string;
  /** Bot-to-bot loop guards. */
  maxJobDepth: number;
  maxJobsPerChain: number;
  routineTickMs: number;
  /** Disable the routine timer (tests). */
  routinesEnabled: boolean;
  /**
   * The server runs inside the desktop app on the user's own computer, so it stops when that
   * computer sleeps or the app quits. Otherwise it is a separate, always-on host.
   */
  onUserComputer: boolean;
  /** Chrome, Edge or Chromium program for the bots' browsers; null = bots have no browser. */
  browserPath: string | null;
  /** Chromium's own sandbox for web pages; turn off only where it cannot start (e.g. running as root). */
  browserSandbox: boolean;
  /** Browsers open at once; the least recently used idle one closes to make room. */
  maxBrowsers: number;
  /** An unwatched browser the bot has not used for this long is closed. */
  browserIdleMs: number;
  /** Private-network hosts the bots' browsers may still reach; every other one is refused. */
  browserLocalHosts: string[];
  /** The longest one step in a bot's browser may take before the browser starts afresh. */
  browserCallMs: number;
  /**
   * The computer service that gives each bot its own desktop; null = none, bots use this
   * server's shell sandbox and browser instead.
   */
  computer: { url: string; token: string } | null;
  /** A desktop nobody is watching and the bot has not used for this long goes to sleep. */
  computerIdleMs: number;
  /**
   * A card in a turn nobody started from the app (a routine, another bot) is closed unanswered
   * after this long; the bot is told and goes on without that step.
   */
  unattendedApprovalMs: number;
  /** How long a connected app's tool call may run before it is given up on. */
  mcpCallTimeoutMs: number;
  /**
   * How long a turn may stay silent before it is stopped as stalled: `silenceMs` while the model
   * should be answering, `toolSilenceMs` while a tool call runs.
   */
  stall: StallLimits;
  /** How long the person's emoji on a bot message must stay put before the bot is told of it. */
  reactionDelayMs: number;
  /** Telegram's Bot API; a self-hosted Bot API server can stand in for it. */
  telegramApi: string;
  /** How long one request for new Telegram messages waits for one to arrive. */
  telegramPollSeconds: number;
  /** Slack's Web API; tests put a stand-in here. */
  slackApi: string;
  /** Discord's REST API with its version; tests put a stand-in here. */
  discordApi: string;
  /** Whether chat apps (Telegram, WhatsApp) connect at all; tests that do not use them leave them off. */
  channelsEnabled: boolean;
  /**
   * The public model catalog that fills in model names, thinking levels and limits the engine's own
   * list lacks, and adds models released since; null keeps to the engine's list (tests, offline).
   */
  modelCatalogUrl: string | null;
}

const list = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * How long a card opened while the person is away waits for an answer. A missing or invalid value
 * is the default; the top is 24 days, under the longest delay a timer can hold.
 */
function unattendedHours(raw: string | undefined): number {
  const hours = Number(raw);
  if (!raw || !Number.isFinite(hours) || hours <= 0) return 12;
  return Math.min(hours, 24 * 24);
}

/** A connected app's tool call limit: 5 minutes unless set, between 10 seconds and an hour. */
export function mcpCallSeconds(raw: string | undefined): number {
  const seconds = Number(raw);
  if (!raw || !Number.isFinite(seconds) || seconds <= 0) return 300;
  return Math.min(Math.max(seconds, 10), 3600);
}

/**
 * How long a turn may stay silent: 10 minutes unless set, between 2 minutes and 4 hours. It cannot
 * be switched off; a turn that hangs would otherwise keep its conversation busy for good.
 */
export function turnStallMinutes(raw: string | undefined): number {
  const minutes = Number(raw);
  if (!raw || !Number.isFinite(minutes) || minutes <= 0) return 10;
  return Math.min(Math.max(minutes, 2), 240);
}

/** An http(s) origin without a trailing slash or path; anything else is ignored with a warning. */
export function publicUrl(raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('protocol');
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    console.warn(`YUMAKBOT_PUBLIC_URL is not an http(s) address and is ignored: ${raw}`);
    return null;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const dataDir = resolve(env.YUMAKBOT_DATA_DIR ?? resolve(process.cwd(), 'data'));
  const defaultApp = resolve(import.meta.dirname, '../../app/dist');
  const appDir = env.YUMAKBOT_APP_DIR
    ? resolve(env.YUMAKBOT_APP_DIR)
    : existsSync(defaultApp)
      ? defaultApp
      : null;
  const mcpCallTimeoutMs = mcpCallSeconds(env.YUMAKBOT_MCP_TIMEOUT_SECONDS) * 1000;
  return {
    host: env.YUMAKBOT_HOST ?? '127.0.0.1',
    port: Number(env.YUMAKBOT_PORT ?? 4319),
    dataDir,
    databaseUrl: env.DATABASE_URL ?? null,
    memoryDb: false,
    accessKey: env.YUMAKBOT_ACCESS_KEY ?? null,
    allowedHosts: list(env.YUMAKBOT_ALLOWED_HOSTS),
    allowedOrigins: list(env.YUMAKBOT_ALLOWED_ORIGINS),
    secureCookies: env.YUMAKBOT_SECURE_COOKIES === '1',
    proxySecret: env.YUMAKBOT_PROXY_SECRET?.trim() || null,
    publicUrl: publicUrl(env.YUMAKBOT_PUBLIC_URL),
    maxConcurrentTurns: Number(env.YUMAKBOT_MAX_TURNS ?? 3),
    appDir,
    engine: env.YUMAKBOT_ENGINE === 'fake' ? 'fake' : 'claude',
    claudeModel: env.YUMAKBOT_CLAUDE_MODEL ?? '',
    maxJobDepth: 4,
    maxJobsPerChain: 20,
    routineTickMs: 30_000,
    routinesEnabled: true,
    onUserComputer: env.YUMAKBOT_ON_USER_COMPUTER === '1',
    browserPath: findBrowser(env),
    browserSandbox: env.YUMAKBOT_BROWSER_SANDBOX !== '0',
    maxBrowsers: Number(env.YUMAKBOT_MAX_BROWSERS ?? 3),
    browserIdleMs: 15 * 60_000,
    browserCallMs: 90_000,
    browserLocalHosts: list(env.YUMAKBOT_BROWSER_LOCAL_HOSTS).map((h) => h.toLowerCase()),
    computer:
      env.YUMAKBOT_COMPUTER_URL && env.YUMAKBOT_COMPUTER_TOKEN
        ? { url: env.YUMAKBOT_COMPUTER_URL.replace(/\/+$/, ''), token: env.YUMAKBOT_COMPUTER_TOKEN }
        : null,
    computerIdleMs: Number(env.YUMAKBOT_COMPUTER_IDLE_MINUTES ?? 15) * 60_000,
    unattendedApprovalMs: unattendedHours(env.YUMAKBOT_UNATTENDED_HOURS) * 60 * 60_000,
    mcpCallTimeoutMs,
    stall: stallLimits({
      silenceMs: turnStallMinutes(env.YUMAKBOT_TURN_STALL_MINUTES) * 60_000,
      mcpCallTimeoutMs,
      shellMaxMs: BASH_MAX_TIMEOUT_MS,
    }),
    reactionDelayMs: 4000,
    telegramApi: (env.YUMAKBOT_TELEGRAM_API || 'https://api.telegram.org').replace(/\/+$/, ''),
    telegramPollSeconds: 50,
    slackApi: (env.YUMAKBOT_SLACK_API || 'https://slack.com/api').replace(/\/+$/, ''),
    discordApi: (env.YUMAKBOT_DISCORD_API || 'https://discord.com/api/v10').replace(/\/+$/, ''),
    channelsEnabled: true,
    modelCatalogUrl: modelCatalogUrl(env.YUMAKBOT_MODEL_CATALOG_URL),
    aiEndpoints: aiEndpointsFrom(env),
    ...overrides,
  };
}

/** models.dev unless the environment names another address; `off` turns the catalog off. */
function modelCatalogUrl(raw: string | undefined): string | null {
  const v = raw?.trim();
  if (v === 'off' || v === '0') return null;
  return v || 'https://models.dev/api.json';
}

export interface EnvAiEndpoint {
  baseUrl: string;
  model: string;
  apiKey: string;
  voice: string;
}

/** The model services the environment names; one without both an address and a model is left out. */
export function aiEndpointsFrom(env: NodeJS.ProcessEnv): Config['aiEndpoints'] {
  const pick = (prefix: string): EnvAiEndpoint | undefined => {
    const baseUrl = env[`${prefix}_BASE_URL`]?.trim();
    const model = env[`${prefix}_MODEL`]?.trim();
    if (!baseUrl || !model) return undefined;
    return {
      baseUrl: baseUrl.replace(/\/+$/, ''),
      model,
      apiKey: env[`${prefix}_API_KEY`]?.trim() ?? '',
      voice: env[`${prefix}_VOICE`]?.trim() ?? '',
    };
  };
  const out: Config['aiEndpoints'] = {};
  const embeddings = pick('AI_EMBEDDINGS');
  const stt = pick('STT');
  const tts = pick('TTS');
  if (embeddings) out.embeddings = embeddings;
  if (stt) out.stt = stt;
  if (tts) out.tts = tts;
  return out;
}
