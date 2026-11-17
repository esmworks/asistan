import { sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sealedJson, sealedProps, sealedText } from './sealed';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const created = () => ts('created_at').notNull().defaultNow();

export const groups = pgTable('groups', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** Order of the groups in the sidebar. */
  position: integer('position').notNull().default(0),
  createdAt: created(),
});

export const bots = pgTable('bots', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  instructions: text('instructions').notNull().default(''),
  engine: text('engine', { enum: ['claude', 'pi'] })
    .notNull()
    .default('claude'),
  model: text('model').notNull().default(''),
  isManager: boolean('is_manager').notNull().default(false),
  /** Shown at the top of the sidebar. Only a place in the list; grants nothing. */
  pinned: boolean('pinned').notNull().default(false),
  /** Order within its sidebar section (the pinned bots, or a group). */
  position: integer('position').notNull().default(0),
  groupId: text('group_id').references(() => groups.id, { onDelete: 'set null' }),
  color: text('color').notNull().default('#4f6bed'),
  avatar: text('avatar').notNull().default('shape:blob'),
  permissionMode: text('permission_mode', { enum: ['ask', 'review', 'auto', 'readonly'] })
    .notNull()
    .default('ask'),
  /** No longer read: kept so the lists set before the internet switch are not lost. */
  allowedDomains: jsonb('allowed_domains').$type<string[]>().notNull().default([]),
  /** Whether the bot may reach the internet: web search, reading pages, its browser and desktop. */
  internet: boolean('internet').notNull().default(true),
  projectDir: text('project_dir'),
  /** Whether the bot reads and keeps memory; off, it works from each conversation alone. */
  memory: boolean('memory').notNull().default(true),
  /** How hard a Claude bot thinks; empty takes the server-wide setting. */
  effort: text('effort').notNull().default(''),
  /** Which tools the bot gets (`ToolSelection`); null for every tool. */
  toolSelection: jsonb('tool_selection'),
  archivedAt: ts('archived_at'),
  createdAt: created(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const threads = pgTable(
  'threads',
  {
    id: text('id').primaryKey(),
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    title: sealedText('title').notNull().default(''),
    // `room`: a conversation of the person with several bots; `botId` is then only its first member.
    // `ticket`: a bot's work on a ticket of the board; listed only while it needs the person.
    kind: text('kind', { enum: ['user', 'bot', 'routine', 'api', 'room', 'ticket'] })
      .notNull()
      .default('user'),
    /** For bot-to-bot threads: the other bot. */
    peerBotId: text('peer_bot_id').references(() => bots.id, { onDelete: 'set null' }),
    engineSessionId: text('engine_session_id'),
    /** What the engine session had cost by its last run; the next run's cost is what it adds. */
    engineSessionCostUsd: doublePrecision('engine_session_cost_usd'),
    /** What the conversation is for, set by the person; every turn in it sees it. */
    goal: text('goal').notNull().default(''),
    /** One message the person pinned above the conversation; null for none. */
    pinnedMessageId: text('pinned_message_id'),
    /** Put away from the conversation list until the person brings it back or writes in it. */
    archivedAt: ts('archived_at'),
    /** Out of the list until this time, or until any new message in it, whichever comes first. */
    snoozedUntil: ts('snoozed_until'),
    /** Kept at the top of the conversation list since then; null when not. */
    pinnedAt: ts('pinned_at'),
    /** An emoji the person gave the conversation, to tell it apart in the list; '' when none. */
    icon: text('icon').notNull().default(''),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('threads_bot_idx').on(t.botId, t.updatedAt),
    uniqueIndex('threads_peer_uq')
      .on(t.botId, t.peerBotId)
      .where(sql`${t.kind} = 'bot'`),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['user', 'assistant', 'system', 'marker', 'approval', 'error'] }).notNull(),
    author: text('author').notNull(),
    text: sealedText('text').notNull().default(''),
    props: sealedProps('props').notNull().default({}),
    clientId: text('client_id'),
    turnId: text('turn_id'),
    createdAt: created(),
  },
  (t) => [
    index('messages_thread_idx').on(t.threadId, t.createdAt),
    uniqueIndex('messages_client_uq')
      .on(t.threadId, t.clientId)
      .where(sql`${t.clientId} is not null`),
  ],
);

/**
 * A room: one thread where the person and several bots talk, one speaker at a time. The row shares
 * its id with the thread. The `*Left` columns are the budget of the exchange under way; each message
 * of the person sets them again, so bots talking among themselves always come to a stop.
 */
export const rooms = pgTable('rooms', {
  id: text('id')
    .primaryKey()
    .references(() => threads.id, { onDelete: 'cascade' }),
  /** Who answers a message that names no one: every member in turn, or nobody. */
  responders: text('responders', { enum: ['everyone', 'mentions'] })
    .notNull()
    .default('everyone'),
  /** Rounds the bots go on talking among themselves after answering the person. */
  rounds: integer('rounds').notNull().default(0),
  roundsLeft: integer('rounds_left').notNull().default(0),
  /** Whether anyone said something in the round under way; a silent round ends the discussion. */
  roundSpoke: boolean('round_spoke').notNull().default(false),
  /** Turns bots may still start for one another (mentions and rounds) in this exchange. */
  botTurnsLeft: integer('bot_turns_left').notNull().default(0),
  createdAt: created(),
});

export const roomMembers = pgTable(
  'room_members',
  {
    roomId: text('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    /** Speaking order. */
    position: integer('position').notNull().default(0),
    /** Each member keeps its own engine session in the room. */
    engineSessionId: text('engine_session_id'),
    /** What that session had cost by its last run; the next run's cost is what it adds. */
    engineSessionCostUsd: doublePrecision('engine_session_cost_usd'),
    /** Time of the last room message this member has been shown; later ones are new to it. */
    seenAt: ts('seen_at'),
    createdAt: created(),
  },
  (t) => [uniqueIndex('room_members_uq').on(t.roomId, t.botId)],
);

export const turns = pgTable(
  'turns',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    // `reaction`: the person left an emoji on a bot message and the bot is told of it.
    // `ticket`: work on a ticket of the board, started by its assignment or a comment on it.
    source: text('source', { enum: ['user', 'reaction', 'routine', 'bot', 'ticket'] }).notNull(),
    status: text('status', {
      enum: ['queued', 'running', 'done', 'error', 'interrupted'],
    }).notNull(),
    prompt: sealedText('prompt').notNull(),
    jobId: text('job_id'),
    routineRunId: text('routine_run_id'),
    error: text('error'),
    costUsd: real('cost_usd'),
    /** The engine and model the turn ran on, for the usage report; null until it starts. */
    engine: text('engine', { enum: ['claude', 'pi'] }),
    model: text('model'),
    createdAt: created(),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    index('turns_status_idx').on(t.status, t.createdAt),
    uniqueIndex('turns_one_running_uq')
      .on(t.threadId)
      .where(sql`${t.status} = 'running'`),
  ],
);

export const approvals = pgTable(
  'approvals',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    turnId: text('turn_id'),
    kind: text('kind', { enum: ['tool', 'question', 'login'] }).notNull(),
    toolName: text('tool_name').notNull(),
    summary: sealedText('summary').notNull().default(''),
    input: sealedJson('input').$type<Record<string, unknown>>().notNull().default({}),
    options: jsonb('options').$type<string[]>().notNull().default([]),
    status: text('status', { enum: ['pending', 'allowed', 'denied', 'expired'] }).notNull(),
    answer: text('answer'),
    remembered: boolean('remembered').notNull().default(false),
    createdAt: created(),
    decidedAt: ts('decided_at'),
  },
  (t) => [index('approvals_status_idx').on(t.status)],
);

export const permissionRules = pgTable('permission_rules', {
  id: text('id').primaryKey(),
  list: text('list', { enum: ['ask', 'allow', 'block'] }).notNull(),
  pattern: text('pattern').notNull(),
  note: text('note').notNull().default(''),
  createdAt: created(),
});

export const memories = pgTable(
  'memories',
  {
    id: text('id').primaryKey(),
    scope: text('scope', { enum: ['bot', 'user'] }).notNull(),
    botId: text('bot_id').references(() => bots.id, { onDelete: 'cascade' }),
    content: sealedText('content').notNull(),
    /** A note on how a site works, given to the bot when it opens that site rather than every turn. */
    site: text('site'),
    source: text('source').notNull().default('user'),
    /**
     * When a bot last looked the note up: a search that found it, or the site it is about opened.
     * Being in the prompt does not count, or every note there would stay in use for good.
     */
    lastUsedAt: ts('last_used_at'),
    useCount: integer('use_count').notNull().default(0),
    /** The note's meaning as numbers, for search by meaning; null until it is indexed. */
    embedding: real('embedding').array(),
    /** Which model and words the embedding is of; a new model or a changed note indexes it again. */
    embeddingKey: text('embedding_key'),
    /** The conversation the bot wrote the note in last; it goes from the note when that does. */
    threadId: text('thread_id').references(() => threads.id, { onDelete: 'set null' }),
    /** The page the fact came from, as the bot gave it, so the person can check it. */
    sourceUrl: sealedText('source_url'),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('memories_scope_idx').on(t.scope, t.botId)],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    before: sealedJson('before'),
    after: sealedJson('after'),
    createdAt: created(),
  },
  (t) => [index('audit_target_idx').on(t.targetType, t.targetId)],
);

export const routines = pgTable('routines', {
  id: text('id').primaryKey(),
  botId: text('bot_id')
    .notNull()
    .references(() => bots.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  prompt: text('prompt').notNull(),
  schedule: jsonb('schedule').notNull(),
  timezone: text('timezone').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  nextRunAt: ts('next_run_at'),
  lastRunAt: ts('last_run_at'),
  /**
   * When the person last opened the routine while its latest run had failed. A failure from before
   * it no longer marks the bot: runs a check skips leave no new result to clear it with.
   */
  failureSeenAt: ts('failure_seen_at'),
  createdAt: created(),
  /** Secret of the routine's webhook address; null when it has none. */
  webhookToken: text('webhook_token'),
  /** A run that came due while the server was off: run it once when back, or skip it. */
  missed: text('missed', { enum: ['run', 'skip'] })
    .notNull()
    .default('run'),
  /** Each run gets the previous run's report, so recurring work builds on what came before. */
  carryReport: boolean('carry_report').notNull().default(false),
  /** Runs in the bot's main conversation, with its context, instead of a conversation of its own. */
  inMain: boolean('in_main').notNull().default(false),
  /** Also runs once each time the server starts (the computer was turned on, the app opened). */
  onStartup: boolean('on_startup').notNull().default(false),
  /** A page checked before each scheduled run; the bot runs only when its text changed. */
  watchUrl: text('watch_url'),
  /** The fingerprint of the watched page's text when it was last read. */
  watchHash: text('watch_hash'),
  /** The watched page's text when it was last read, cut short, so a change can be shown as what changed. */
  watchText: text('watch_text'),
  /** A connected app's read-only tool called before each scheduled run (`RoutineCheck`); null for none. */
  check: jsonb('check'),
  /** The fingerprint of the check's answer when it was last called. */
  checkHash: text('check_hash'),
  /** Conditions a webhook call's JSON body must meet to start the routine; empty for none. */
  webhookFilter: text('webhook_filter').notNull().default(''),
  /** A webhook call only posts what it carries, as the bot's message, without running the bot. */
  webhookPost: boolean('webhook_post').notNull().default(false),
  /** The model its runs use, on the bot's own engine; empty for the bot's model. */
  model: text('model').notNull().default(''),
  /** Also runs when mail arrives at the bot's address. */
  emailTrigger: boolean('email_trigger').notNull().default(false),
  /** Conditions a mail must meet to start it (as the webhook filter, on from, to, subject, text). */
  emailFilter: text('email_filter').notNull().default(''),
});

export const routineRuns = pgTable(
  'routine_runs',
  {
    id: text('id').primaryKey(),
    routineId: text('routine_id')
      .notNull()
      .references(() => routines.id, { onDelete: 'cascade' }),
    occurrence: text('occurrence').notNull(),
    status: text('status', { enum: ['running', 'done', 'error', 'skipped', 'waiting'] }).notNull(),
    reason: text('reason'),
    threadId: text('thread_id'),
    promptSnapshot: text('prompt_snapshot').notNull(),
    /** The bot itself said the run could not do its task. */
    failedByBot: boolean('failed_by_bot').notNull().default(false),
    /** What the routine pre-check said before the run; null when none ran. */
    gateDecision: text('gate_decision', { enum: ['run', 'skip'] }),
    gateReason: text('gate_reason'),
    /** What the pre-check cost, as the engine reported it. */
    gateCostUsd: real('gate_cost_usd'),
    startedAt: created(),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    uniqueIndex('routine_runs_occurrence_uq').on(t.routineId, t.occurrence),
    uniqueIndex('routine_runs_one_active_uq')
      .on(t.routineId)
      .where(sql`${t.status} in ('running', 'waiting')`),
  ],
);

/**
 * Each instruction a routine has had, newest last: written when a routine is made and whenever its
 * instruction changes, so an earlier one can be compared and brought back. Bringing one back
 * writes it again as the newest, so the history only grows.
 */
export const routineRevisions = pgTable(
  'routine_revisions',
  {
    id: text('id').primaryKey(),
    routineId: text('routine_id')
      .notNull()
      .references(() => routines.id, { onDelete: 'cascade' }),
    prompt: text('prompt').notNull(),
    createdAt: created(),
  },
  (t) => [index('routine_revisions_routine_idx').on(t.routineId, t.createdAt)],
);

/** Bot-to-bot requests. A job chain shares `rootId`; `depth` guards against loops. */
export const jobs = pgTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    rootId: text('root_id').notNull(),
    depth: integer('depth').notNull(),
    // `notify`: the sender expects no answer; the target's reply is not passed back.
    kind: text('kind', { enum: ['send', 'ask', 'notify'] }).notNull(),
    fromBotId: text('from_bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    toBotId: text('to_bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    fromThreadId: text('from_thread_id').notNull(),
    /** The sender's turn that made the request; replies to one turn come back together. */
    fromTurnId: text('from_turn_id'),
    toThreadId: text('to_thread_id').notNull(),
    /** Server-side approval record carried with the request, if any. */
    approvalId: text('approval_id'),
    request: sealedText('request').notNull(),
    reply: sealedText('reply'),
    status: text('status', { enum: ['pending', 'done', 'error', 'stopped'] }).notNull(),
    createdAt: created(),
    finishedAt: ts('finished_at'),
    /** When the reply was handed to the sender; replies wait for the others of their turn. */
    deliveredAt: ts('delivered_at'),
  },
  (t) => [
    index('jobs_root_idx').on(t.rootId),
    index('jobs_to_idx').on(t.toThreadId, t.status),
    index('jobs_from_turn_idx').on(t.fromTurnId),
  ],
);

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  createdAt: created(),
  lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  /** The browser or app that signed in, so the person can tell their devices apart. */
  userAgent: text('user_agent'),
});

/**
 * Phones that want notifications while the app is closed. A device belongs to the session that
 * registered it: once that session ends, the device gets nothing more.
 */
export const pushDevices = pgTable('push_devices', {
  token: text('token').primaryKey(),
  platform: text('platform', { enum: ['ios'] }).notNull(),
  /** The registering session's id (a hash, like sessions.id); null when it came with the access key. */
  sessionId: text('session_id'),
  locale: text('locale').notNull(),
  level: text('level', { enum: ['all', 'needsYou', 'off'] }).notNull(),
  mutes: jsonb('mutes').$type<Record<string, number | null>>().notNull().default({}),
  /** Apple's test service answers for builds run from Xcode; learnt on the first send. */
  sandbox: boolean('sandbox'),
  createdAt: created(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/**
 * The user's saved sign-ins. The password is encrypted with the vault key (see services/vault.ts);
 * bots never read it, the server types it into the matching site.
 */
export const vaultLogins = pgTable(
  'vault_logins',
  {
    id: text('id').primaryKey(),
    /** Domain the sign-in belongs to, e.g. facebook.com; also used on its subdomains. */
    site: text('site').notNull(),
    username: text('username').notNull(),
    secret: text('secret').notNull(),
    /** The authenticator secret for two-step codes, sealed like the password; null when none. */
    totp: text('totp'),
    /** The bots that may use the sign-in; null lets every bot. */
    botIds: jsonb('bot_ids').$type<string[]>(),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    lastUsedAt: ts('last_used_at'),
  },
  (t) => [uniqueIndex('vault_logins_site_user_uq').on(t.site, t.username)],
);

export const kv = pgTable('kv', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
});

/**
 * Remote MCP servers bots may use. `secrets` is sealed with the vault key (token, OAuth tokens and
 * client); `tools` is the server's tool list as last fetched, with the person's choices.
 */
export const connections = pgTable(
  'connections',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    catalogId: text('catalog_id'),
    url: text('url').notNull(),
    auth: text('auth', { enum: ['oauth', 'token', 'none'] }).notNull(),
    status: text('status', { enum: ['connected', 'signed-out', 'error'] }).notNull(),
    error: text('error'),
    secrets: text('secrets'),
    tools: jsonb('tools').$type<StoredConnectionTool[]>().notNull().default([]),
    /** Open to every bot; when off, only the bots in bot_connections. */
    allBots: boolean('all_bots').notNull().default(true),
    /** A tool's own view (an MCP app) shows in the conversation when one is called. */
    showApps: boolean('show_apps').notNull().default(true),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('connections_slug_uq').on(t.slug)],
);

export interface StoredConnectionTool {
  name: string;
  title: string | null;
  description: string;
  inputSchema: Record<string, unknown>;
  hinted: 'read' | 'write';
  /** The person's choice; null follows the hint. */
  kind: 'read' | 'write' | null;
  enabled: boolean;
  /** The tool's own view (`ui://…`), shown in the conversation when it is called. */
  ui?: string | null;
  /** Meant for its view alone: never given to a bot. */
  appOnly?: boolean;
}

/** Which bots may use a connection that is not open to every bot. */
export const botConnections = pgTable(
  'bot_connections',
  {
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    createdAt: created(),
  },
  (t) => [uniqueIndex('bot_connections_uq').on(t.botId, t.connectionId)],
);

/** OAuth sign-ins under way: the state sent to the service, and its PKCE verifier (sealed). */
export const connectionSignins = pgTable('connection_signins', {
  state: text('state').primaryKey(),
  connectionId: text('connection_id')
    .notNull()
    .references(() => connections.id, { onDelete: 'cascade' }),
  verifier: text('verifier').notNull(),
  redirectUrl: text('redirect_url').notNull(),
  createdAt: created(),
});

/** Written instructions for a kind of task; a bot reads one when its task calls for it. */
export const skills = pgTable(
  'skills',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    body: text('body').notNull().default(''),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('skills_name_uq').on(t.name)],
);

/** Which bots have a skill turned on. */
export const botSkills = pgTable(
  'bot_skills',
  {
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    skillId: text('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    createdAt: created(),
  },
  (t) => [uniqueIndex('bot_skills_uq').on(t.botId, t.skillId)],
);

/**
 * A chat app the person talks to bots through. Telegram: one row per bot, with that bot's own
 * Telegram bot (its token sealed with the vault key) and the one Telegram account paired with it.
 * WhatsApp: a single row for the linked number; `botId` is the bot its messages go to now.
 */
export const channels = pgTable(
  'channels',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['telegram', 'whatsapp'] }).notNull(),
    botId: text('bot_id').references(() => bots.id, { onDelete: 'set null' }),
    /** Telegram: the bot token, sealed. */
    secret: text('secret'),
    /** What the chat app says about the account the server uses (Telegram bot name, linked number). */
    account: jsonb('account').$type<Record<string, unknown>>().notNull().default({}),
    /** The person's id in the chat app; nobody else's messages are read. Null until paired. */
    owner: text('owner'),
    ownerName: text('owner_name'),
    /** Telegram: the code the person sends with /start to pair; good until `pairUntil`. */
    pairCode: text('pair_code'),
    pairUntil: ts('pair_until'),
    /** Choices of the person (WhatsApp: own number or a separate bot number). */
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    /** Telegram: the next update to read. */
    cursor: text('cursor'),
    /** Why the connection stopped working, in the chat app's words; null while it works. */
    error: text('error'),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('channels_telegram_bot_uq')
      .on(t.botId)
      .where(sql`${t.kind} = 'telegram'`),
    uniqueIndex('channels_whatsapp_uq')
      .on(t.kind)
      .where(sql`${t.kind} = 'whatsapp'`),
  ],
);

/** Which message in a chat app is which message here, so an answer to one finds its place. */
export const channelMessages = pgTable(
  'channel_messages',
  {
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('channel_messages_uq').on(t.channelId, t.externalId),
    index('channel_messages_message_idx').on(t.messageId),
  ],
);

/** The linked WhatsApp device's keys, each sealed with the vault key. */
export const whatsappKeys = pgTable('whatsapp_keys', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

/**
 * A memory change a bot asked for while nobody was watching (a routine, another bot's request):
 * it waits here until the person accepts or rejects it, so what a webhook call or a page the bot
 * read says cannot turn into memory every later turn trusts.
 */
export const memoryChanges = pgTable(
  'memory_changes',
  {
    id: text('id').primaryKey(),
    action: text('action', { enum: ['write', 'update', 'forget'] }).notNull(),
    /** The note an update or a forget is about; the change goes when the note does. */
    memoryId: text('memory_id').references(() => memories.id, { onDelete: 'cascade' }),
    scope: text('scope', { enum: ['bot', 'user'] }).notNull(),
    botId: text('bot_id').references(() => bots.id, { onDelete: 'cascade' }),
    site: text('site'),
    /** The note's words after the change (for a forget, the words that would go). */
    content: sealedText('content').notNull(),
    /** The note's words before an update. */
    before: sealedText('before'),
    /** The bot that asked for it. */
    proposedBy: text('proposed_by')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    /** Why nobody was watching: a routine's run or another bot's request, with its name. */
    origin: jsonb('origin').$type<{ kind: 'routine' | 'bot'; name: string }>().notNull(),
    threadId: text('thread_id'),
    /** The page the bot said the fact came from; kept on the note once accepted. */
    sourceUrl: sealedText('source_url'),
    createdAt: created(),
  },
  (t) => [index('memory_changes_created_idx').on(t.createdAt)],
);

/**
 * Pages a bot made that anyone with the link may open without signing in. The token is the whole
 * secret of the link; deleting the row turns the link off. The page is read fresh on every visit,
 * so the link shows the file as the bot last wrote it.
 */
export const pageShares = pgTable(
  'page_shares',
  {
    token: text('token').primaryKey(),
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    /** The page's path in the bot's library, as its card in the conversation holds it. */
    path: text('path').notNull(),
    name: text('name').notNull(),
    createdAt: created(),
  },
  (t) => [uniqueIndex('page_shares_page_uq').on(t.botId, t.path)],
);

/**
 * API keys the person saved for bots to call a service with. The value is sealed with the vault
 * key; bots know a key only by its name, and the server adds it to requests for its origin alone.
 */
export const apiCredentials = pgTable(
  'api_credentials',
  {
    id: text('id').primaryKey(),
    /** The reference name bots use, e.g. `github` or `weather_api`. */
    name: text('name').notNull(),
    /** The only origin the key is sent to, e.g. `https://api.example.com`. */
    origin: text('origin').notNull(),
    /** How the key goes with a request (`ApiAuth`). */
    auth: jsonb('auth').$type<Record<string, unknown>>().notNull(),
    label: text('label').notNull().default(''),
    secret: text('secret').notNull(),
    /** The bots that may use it; null lets every bot. */
    botIds: jsonb('bot_ids').$type<string[]>(),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    lastUsedAt: ts('last_used_at'),
  },
  (t) => [uniqueIndex('api_credentials_name_uq').on(t.name)],
);

/**
 * Addresses bots receive mail at, under the domain set in the settings. A name is never given to
 * another bot, even once its bot is gone: mail meant for the old one must not reach a new one.
 */
export const emailAddresses = pgTable('email_addresses', {
  /** The part before the @, lowercase. */
  name: text('name').primaryKey(),
  /** Null once its bot gave it up or was deleted; the name stays taken. */
  botId: text('bot_id').references(() => bots.id, { onDelete: 'set null' }),
  createdAt: created(),
});

/** Mail that arrived at a bot's address: its inbox, which the bot reads when it needs to. */
export const emails = pgTable(
  'emails',
  {
    id: text('id').primaryKey(),
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    /** The address it came to. */
    to: text('to').notNull(),
    from: text('from').notNull(),
    fromName: text('from_name').notNull().default(''),
    subject: sealedText('subject').notNull().default(''),
    /** The mail's text: its plain part, or its HTML part reduced to text. */
    text: sealedText('text').notNull().default(''),
    /** The sender's Message-ID; the same mail delivered twice is kept once. */
    messageId: text('message_id'),
    /** Attached files, saved in the bot's own folder (`{ name, size, path }`). */
    attachments: jsonb('attachments')
      .$type<{ name: string; size: number; path: string }[]>()
      .notNull()
      .default([]),
    receivedAt: created(),
    readAt: ts('read_at'),
  },
  (t) => [
    index('emails_bot_idx').on(t.botId, t.receivedAt),
    uniqueIndex('emails_message_uq')
      .on(t.botId, t.messageId)
      .where(sql`${t.messageId} is not null`),
  ],
);

/**
 * OpenAPI documents bots may call operations of. The operations are read from the document when
 * it is added; calls go through the API key named here, to the document's server only.
 */
export const apiSources = pgTable(
  'api_sources',
  {
    id: text('id').primaryKey(),
    /** The reference name bots use, e.g. `weather`. */
    name: text('name').notNull(),
    title: text('title').notNull().default(''),
    specUrl: text('spec_url'),
    /** Where the operations are called: the document's server, or the person's own address. */
    baseUrl: text('base_url').notNull(),
    /** The saved API key's name; null for an API that needs none. */
    credential: text('credential'),
    operations: jsonb('operations').$type<Record<string, unknown>[]>().notNull().default([]),
    botIds: jsonb('bot_ids').$type<string[]>(),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('api_sources_name_uq').on(t.name)],
);

/**
 * The board: tickets the person and the bots both work from. A ticket assigned to a bot starts it
 * on the work in a conversation of its own; what the bot reports comes back as a comment.
 */
export const tickets = pgTable(
  'tickets',
  {
    id: text('id').primaryKey(),
    /** Shown as #12; grows by one with each ticket. */
    number: integer('number').notNull(),
    title: sealedText('title').notNull(),
    description: sealedText('description').notNull().default(''),
    status: text('status', { enum: ['todo', 'in_progress', 'in_review', 'blocked', 'done', 'wont_do'] })
      .notNull()
      .default('todo'),
    priority: text('priority', { enum: ['low', 'normal', 'high', 'urgent'] })
      .notNull()
      .default('normal'),
    assigneeBotId: text('assignee_bot_id').references(() => bots.id, { onDelete: 'set null' }),
    /** `user`, or `bot:<id>` for a ticket a bot made. */
    createdBy: text('created_by').notNull(),
    /** The conversation the assignee works on it in; made on its first assignment. */
    threadId: text('thread_id').references(() => threads.id, { onDelete: 'set null' }),
    /**
     * Where it stands among the tickets of its column, smallest first. A fraction, so a ticket
     * moved between two others takes a place between theirs without the rest moving.
     */
    position: doublePrecision('position').notNull().default(0),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('tickets_number_uq').on(t.number), index('tickets_status_idx').on(t.status)],
);

export const ticketComments = pgTable(
  'ticket_comments',
  {
    id: text('id').primaryKey(),
    ticketId: text('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    /** `user` or `bot:<id>`. */
    author: text('author').notNull(),
    text: sealedText('text').notNull(),
    createdAt: created(),
  },
  (t) => [index('ticket_comments_ticket_idx').on(t.ticketId, t.createdAt)],
);

/**
 * A bot's tables: records it keeps in rows and columns, which the person can read, correct and
 * export. A name is unique per bot, so a bot finds its table by the name it gave it.
 */
export const botTables = pgTable(
  'bot_tables',
  {
    id: text('id').primaryKey(),
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** The columns in order, each with its type (`TableColumn`). */
    columns: jsonb('columns')
      .$type<{ name: string; type: 'text' | 'number' | 'date' | 'bool' | 'url' }[]>()
      .notNull(),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('bot_tables_name_uq').on(t.botId, t.name)],
);

export const botTableRows = pgTable(
  'bot_table_rows',
  {
    id: text('id').primaryKey(),
    tableId: text('table_id')
      .notNull()
      .references(() => botTables.id, { onDelete: 'cascade' }),
    /** The row's values by column name; sealed with the conversations when sealing is on. */
    values: sealedJson('values').$type<Record<string, string | number | boolean | null>>().notNull(),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('bot_table_rows_table_idx').on(t.tableId, t.createdAt)],
);
