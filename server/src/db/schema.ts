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
    title: text('title').notNull().default(''),
    // `room`: a conversation of the person with several bots; `botId` is then only its first member.
    kind: text('kind', { enum: ['user', 'bot', 'routine', 'api', 'room'] })
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
    text: text('text').notNull().default(''),
    props: jsonb('props').$type<Record<string, unknown>>().notNull().default({}),
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
    source: text('source', { enum: ['user', 'reaction', 'routine', 'bot'] }).notNull(),
    status: text('status', {
      enum: ['queued', 'running', 'done', 'error', 'interrupted'],
    }).notNull(),
    prompt: text('prompt').notNull(),
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
    summary: text('summary').notNull().default(''),
    input: jsonb('input').$type<Record<string, unknown>>().notNull().default({}),
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
  list: text('list', { enum: ['ask', 'allow'] }).notNull(),
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
    content: text('content').notNull(),
    /** A note on how a site works, given to the bot when it opens that site rather than every turn. */
    site: text('site'),
    source: text('source').notNull().default('user'),
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
    before: jsonb('before'),
    after: jsonb('after'),
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
    request: text('request').notNull(),
    reply: text('reply'),
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
