import { createReadStream, readdirSync, realpathSync, statSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import type { BackupService } from './services/backup';
import { MAX_AUDIO_BYTES, type TranscribeService } from './services/transcribe';
import { MAX_EMAIL_BYTES } from './services/email';
import { Readable } from 'node:stream';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import {
  AccessRequest,
  AccountSet,
  ApprovalDecision,
  BotCreate,
  BotMove,
  BotUpdate,
  ApnsSet,
  ClaudeAuthSet,
  PushDeviceSet,
  type ClaudeAuthStatus,
  type ClaudeModel,
  ConnectionBots,
  ConnectionCreate,
  ConnectionToolPatch,
  ConnectionUpdate,
  CustomEndpointCreate,
  CustomEndpointUpdate,
  FileName,
  LoginRequest,
  GroupCreate,
  GroupMove,
  MAX_BOT_IMPORT_BYTES,
  MemoryCreate,
  MemoryUpdate,
  MessageReaction,
  patchOf,
  PermissionRuleCreate,
  ProviderKeyInput,
  ProviderSignInStart,
  LOCALES,
  pickLocale,
  RoutineCreate,
  RoutineUpdate,
  RoomCreate,
  RoomSend,
  RoomUpdate,
  SendMessage,
  SkillBot,
  SkillCreate,
  SkillUpdate,
  TelegramConnect,
  TelegramUpdate,
  WhatsAppSet,
  type ServerInfo,
  ThreadCreate,
  USAGE_RANGES,
  type UsageRange,
  VaultLoginCreate,
  VaultLoginUpdate,
  frameCsp,
  frameDocument,
  frameHeader,
  PAGE_LIBRARIES,
  PageShareCreate,
  ApiCredentialCreate,
  ApiCredentialUpdate,
  EmailClaim,
  AI_KINDS,
  AiEndpointSet,
  PluginInstall,
  ApiSourceCreate,
  TicketCommentCreate,
  RowValues,
  TicketCreate,
  TicketUpdate,
  skillSlug,
} from '@yumakbot/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MIN_PASSWORD } from './account';
import { clientAddress, SESSION_COOKIE, SESSION_IDLE_MS, type Auth } from './auth';
import { BrowserError } from './browser/manager';
import type { Config } from './config';
import { PLAIN_PAGE_POLICY } from './csp';
import { translator } from './i18n';
import { schema } from './db';
import type { AccountStatus, ModelTest } from './engine/types';
import type { Services } from './services';
import { OAUTH_CALLBACK_PATH, oauthRedirectUrl } from './services/connections';
import { fetchSkillFile } from './services/skill-link';
import { Settings } from './services/settings';
import { EMOJI } from './tools';
import { attachedFiles, saveUpload, stagingDir } from './uploads';
import { HttpError, truncate } from './util';
import { findProjects, findSetup } from './services/setup-import';
import { APP_DIR } from './runtime/turns';
import { bundlePage } from './tools/page-bundle';
import { stepsText } from './browser/teach';
import { workspacePaths } from './workspace';
import { uniqueName, zip } from './zip';

/** Where services start routines by their secret address; needs no access key. */
export const WEBHOOK_PATH = '/api/hooks/routines';
/** Where a mail relay hands over messages; it signs in with the mail secret, not the access key. */
export const EMAIL_INBOUND_PATH = '/api/email/inbound';
/** Where a shared page opens, outside /api so it needs no sign-in. */
export const SHARE_PATH = '/p';
/** Longest text a script may hand a routine run. */
const MAX_PAYLOAD = 50_000;
/** The largest webhook body read; GitHub sends up to 25 MB, but what a bot reads is cut far shorter. */
const WEBHOOK_BODY_MAX = 5 * 1024 * 1024;
/** Most bytes put in one ZIP download; it is built in memory. */
const MAX_ZIP_BYTES = 200 * 1024 * 1024;
import { eq } from 'drizzle-orm';

interface Deps {
  services: Services;
  backup: BackupService;
  transcribe: TranscribeService;
  auth: Auth;
  config: Config;
  info(): ServerInfo;
  checkClaude(): Promise<AccountStatus>;
  claude: {
    status(): Promise<ClaudeAuthStatus>;
    /** Saves the token or key, then checks it with one real request. */
    set(input: ClaudeAuthSet): Promise<ServerInfo['claude']>;
    clear(): Promise<ServerInfo['claude']>;
    models(): Promise<ClaudeModel[]>;
  };
  /** One short request to a provider's model with its stored key. */
  testModel(provider: string, model: string): Promise<ModelTest>;
}

const IdParams = z.object({ id: z.string().min(1) });

/** Library files the page may show as pictures. */
/** What the page may show in place: raster images, and PDFs in the browser's own viewer. */
const INLINE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  // Shown only as a picture, and sandboxed below: a script inside it never runs.
  '.svg': 'image/svg+xml',
  // Sound and video play in the page's own player; they cannot run anything.
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

/** `bytes=a-b` of a file of `size` bytes, or null when absent or not one satisfiable range. */
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | null {
  const m = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!m || (!m[1] && !m[2])) return null;
  let start: number;
  let end: number;
  if (!m[1]) {
    // The last n bytes.
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  return start <= end && start < size ? { start, end } : null;
}

/** A browser problem as an answer to the person who asked. */
function browserHttpError(err: unknown): unknown {
  if (!(err instanceof BrowserError)) return err;
  switch (err.code) {
    case 'busy':
      return new HttpError(409, 'browser.busy');
    case 'badUrl':
      return new HttpError(400, 'browser.badUrl', { url: err.message });
    case 'launch':
      return new HttpError(502, 'browser.launchFailed', { message: err.message });
    default:
      return new HttpError(409, 'browser.windowUnavailable');
  }
}

export function registerRoutes(app: FastifyInstance, d: Deps) {
  const s = d.services;

  app.get('/api/health', async () => ({ ok: true }));

  const sessionCookie = {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: d.config.secureCookies,
    path: '/',
    maxAge: Math.floor(SESSION_IDLE_MS / 1000),
  };
  app.get('/api/session', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    const how = await d.auth.authenticate(req.headers, token);
    // Each visit moves the cookie's end along with the session's.
    if (how === 'cookie' && token) reply.setCookie(SESSION_COOKIE, token, sessionCookie);
    // Whether the sign-in page asks for a username and password or for the access key.
    return { authenticated: !!how, account: (await d.auth.account.username()) !== null };
  });
  app.get('/api/sessions', async (req) => d.auth.listSessions(req.cookies[SESSION_COOKIE]));
  app.delete('/api/sessions/:id', async (req) => {
    const id = z.object({ id: z.string().min(1).max(64) }).parse(req.params).id;
    const ended = await d.auth.revokeSessions(
      req.cookies[SESSION_COOKIE],
      id === 'others' ? 'others' : { id },
    );
    return { ended };
  });

  app.post('/api/access', async (req, reply) => {
    const { key } = AccessRequest.parse(req.body);
    if (!d.auth.checkKey(key)) {
      await new Promise((r) => setTimeout(r, 300));
      throw new HttpError(401, 'error.accessKeyWrong');
    }
    const token = await d.auth.createSession(req.headers['user-agent']);
    reply.setCookie(SESSION_COOKIE, token, sessionCookie);
    return { ok: true };
  });

  app.post('/api/login', async (req, reply) => {
    const { username, password } = LoginRequest.parse(req.body);
    const from = clientAddress(req.headers, req.ip, d.config);
    if (d.auth.throttle.blocked(from)) throw new HttpError(429, 'error.loginBlocked');
    if (!(await d.auth.account.check(password, username))) {
      d.auth.throttle.failed(from);
      throw new HttpError(401, 'error.loginWrong');
    }
    d.auth.throttle.succeeded(from);
    reply.setCookie(SESSION_COOKIE, await d.auth.createSession(req.headers['user-agent']), sessionCookie);
    return { ok: true };
  });

  // Pairing: a signed-in device makes a short code; another device signs in with it once.
  app.post('/api/pairing', async () => ({
    ...d.auth.createPairingCode(),
    // Where the other device finds this server, when it is known to the server.
    url: d.config.publicUrl ?? null,
  }));
  app.post('/api/pair', async (req, reply) => {
    const { code, token: wantToken } = z
      .object({ code: z.string().min(1).max(40), token: z.boolean().optional() })
      .parse(req.body);
    // Wrong codes count with wrong passwords: guessing either is slowed the same way.
    const from = clientAddress(req.headers, req.ip, d.config);
    if (d.auth.throttle.blocked(from)) throw new HttpError(429, 'error.loginBlocked');
    if (!d.auth.usePairingCode(code)) {
      d.auth.throttle.failed(from);
      await new Promise((r) => setTimeout(r, 300));
      throw new HttpError(401, 'error.pairingWrong');
    }
    d.auth.throttle.succeeded(from);
    const token = await d.auth.createSession(req.headers['user-agent']);
    reply.setCookie(SESSION_COOKIE, token, sessionCookie);
    // The desktop app pairs from its own process and puts the session in its window's cookies.
    return wantToken
      ? { ok: true, token, cookie: SESSION_COOKIE, maxAge: sessionCookie.maxAge }
      : { ok: true };
  });

  app.get('/api/account', async () => ({ username: await d.auth.account.username() }));
  app.put('/api/account', async (req) => {
    const { username, password, current } = AccountSet.parse(req.body);
    if (password.length < MIN_PASSWORD) {
      throw new HttpError(400, 'error.passwordShort', { min: String(MIN_PASSWORD) });
    }
    // Changing it takes the current password, or the access key when that is forgotten.
    if ((await d.auth.account.username()) !== null) {
      const from = clientAddress(req.headers, req.ip, d.config);
      if (d.auth.throttle.blocked(from)) throw new HttpError(429, 'error.loginBlocked');
      const ok = !!current && (d.auth.checkKey(current) || (await d.auth.account.check(current)));
      if (!ok) {
        d.auth.throttle.failed(from);
        throw new HttpError(403, 'error.currentPasswordWrong');
      }
    }
    await d.auth.account.set(username, password);
    return { username: username.trim() };
  });

  app.post('/api/logout', async (req, reply) => {
    await d.auth.endSession(req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/info', async () => d.info());
  app.post('/api/info/claude-check', async () => d.checkClaude());

  app.get('/api/settings', async () => s.settings.all());
  app.patch('/api/settings', async (req) => s.settings.update(patchOf(Settings).parse(req.body)));

  // API keys for the Pi engine; responses carry only a hint of each key.
  const ProviderParams = z.object({ id: z.string().regex(/^[a-z0-9-]{2,60}$/) });
  // How Claude bots sign in. The token or key is write-only: reads return a hint.
  app.get('/api/claude/auth', async () => d.claude.status());
  app.put('/api/claude/auth', async (req) => d.claude.set(ClaudeAuthSet.parse(req.body)));
  app.delete('/api/claude/auth', async () => d.claude.clear());
  app.get('/api/claude/models', async () => d.claude.models());

  // Notifications on phones while the app is closed. The Apple key is write-only.
  const PushToken = z.object({ token: z.string().regex(/^[0-9a-fA-F]{32,200}$/) });
  app.put('/api/push/device', async (req) => {
    await s.push.register(PushDeviceSet.parse(req.body), req.cookies[SESSION_COOKIE]);
    return { ok: true };
  });
  app.delete('/api/push/device/:token', async (req) => {
    await s.push.unregister(PushToken.parse(req.params).token);
    return { ok: true };
  });
  app.post('/api/push/test', async (req) => {
    await s.push.test(PushToken.parse(req.body).token);
    return { ok: true };
  });
  app.get('/api/push/apns', async () => s.push.apnsStatus());
  app.put('/api/push/apns', async (req) => {
    await s.push.setApns(ApnsSet.parse(req.body));
    return s.push.apnsStatus();
  });
  app.delete('/api/push/apns', async () => {
    await s.push.clearApns();
    return s.push.apnsStatus();
  });

  app.get('/api/providers', async () => s.keys.list());
  app.get('/api/providers/:id/models', async (req) => s.keys.models(ProviderParams.parse(req.params).id));
  app.put('/api/providers/:id/key', async (req) => {
    await s.keys.set(ProviderParams.parse(req.params).id, ProviderKeyInput.parse(req.body).key);
    return { ok: true };
  });
  app.post('/api/providers/:id/test', async (req) =>
    d.testModel(
      ProviderParams.parse(req.params).id,
      z.object({ model: z.string().trim().min(1).max(200) }).parse(req.body).model,
    ),
  );
  // Signing in with the person's own plan (ChatGPT, Copilot); the app follows the sign-in it starts.
  app.post('/api/providers/:id/sign-in', async (req) =>
    s.subscriptions.start(ProviderParams.parse(req.params).id, ProviderSignInStart.parse(req.body ?? {})),
  );
  app.get('/api/sign-ins/:id', async (req) => s.subscriptions.status(IdParams.parse(req.params).id));
  app.post('/api/sign-ins/:id/paste', async (req) =>
    s.subscriptions.paste(
      IdParams.parse(req.params).id,
      z.object({ input: z.string().min(1).max(4000) }).parse(req.body).input,
    ),
  );
  app.delete('/api/sign-ins/:id', async (req) => {
    s.subscriptions.cancel(IdParams.parse(req.params).id);
    return { ok: true };
  });
  app.delete('/api/providers/:id/sign-in', async (req) => {
    await s.subscriptions.signOut(ProviderParams.parse(req.params).id);
    return { ok: true };
  });
  app.delete('/api/providers/:id/key', async (req) => {
    await s.keys.remove(ProviderParams.parse(req.params).id);
    return { ok: true };
  });
  // The person's own OpenAI-compatible endpoints, listed among the providers.
  app.post('/api/providers/custom', async (req) => s.keys.addEndpoint(CustomEndpointCreate.parse(req.body)));
  app.get('/api/providers/discover', async () => s.keys.discover());
  app.patch('/api/providers/:id', async (req) =>
    s.keys.updateEndpoint(ProviderParams.parse(req.params).id, CustomEndpointUpdate.parse(req.body)),
  );
  app.post('/api/providers/:id/refresh', async (req) =>
    s.keys.refreshEndpoint(ProviderParams.parse(req.params).id),
  );
  app.delete('/api/providers/:id', async (req) => {
    await s.keys.removeEndpoint(ProviderParams.parse(req.params).id);
    return { ok: true };
  });

  // Bots and groups
  app.get('/api/bots', async (req) => {
    const q = z.object({ archived: z.enum(['0', '1']).optional() }).parse(req.query);
    return s.bots.list({ includeArchived: q.archived === '1' });
  });
  app.post('/api/bots', async (req) => s.bots.create(BotCreate.parse(req.body)));
  app.get('/api/bots/:id', async (req) => s.bots.get(IdParams.parse(req.params).id));
  app.patch('/api/bots/:id', async (req) =>
    s.bots.update(IdParams.parse(req.params).id, BotUpdate.parse(req.body)),
  );
  app.post('/api/bots/:id/move', async (req) =>
    s.bots.move(IdParams.parse(req.params).id, BotMove.parse(req.body)),
  );
  app.post('/api/bots/:id/archive', async (req) => s.bots.archive(IdParams.parse(req.params).id));
  app.post('/api/bots/:id/restore', async (req) => s.bots.restore(IdParams.parse(req.params).id));
  app.delete('/api/bots/:id', async (req) => {
    const id = IdParams.parse(req.params).id;
    // An archived bot leaves its rooms first, so a room it started is not removed with it.
    if ((await s.bots.get(id)).archivedAt) await s.rooms.removeBot(id);
    await s.bots.purge(id);
    await s.ctx.browser.close(id).catch(() => {});
    // Its folders go with it: files, conversations, the browser profile.
    const data = d.config.dataDir;
    for (const dir of [join(data, 'workspaces', 'bots', id), join(data, 'browsers', id)]) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    return { ok: true };
  });
  // The bot's browser as an ordinary window on this computer, for signing in by hand.
  app.post('/api/bots/:id/browser/window', async (req) => {
    const { id } = IdParams.parse(req.params);
    const { url } = z.object({ url: z.string().trim().max(2000).optional() }).parse(req.body ?? {});
    await s.bots.get(id);
    const browser = s.ctx.browser;
    if (!browser.windowAvailable) throw new HttpError(409, 'browser.windowUnavailable');
    try {
      await browser.openWindow(id, url || undefined);
    } catch (err) {
      throw browserHttpError(err);
    }
    return { ok: true };
  });
  app.delete('/api/bots/:id/browser/window', async (req) => {
    await s.ctx.browser.closeWindow(IdParams.parse(req.params).id);
    return { ok: true };
  });
  app.get('/api/bots/:id/audit', async (req) => s.tools.auditFor(IdParams.parse(req.params).id));
  app.get('/api/summaries', async () => s.threads.summaries());
  app.get('/api/search', async (req) => {
    const q = z
      .object({
        q: z.string().max(200),
        threadId: z.string().min(1).max(64).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      })
      .parse(req.query);
    return s.threads.search(q.q, { threadId: q.threadId, limit: q.limit });
  });
  app.get('/api/usage', async (req) => {
    const q = z
      .object({ days: z.coerce.number().int().default(30), bot: z.string().min(1).max(64).optional() })
      .refine((v) => (USAGE_RANGES as readonly number[]).includes(v.days), 'validation.usageRange')
      .parse(req.query);
    return s.usage.report(q.days as UsageRange, q.bot);
  });
  app.get('/api/today', async () => ({
    ...(await s.usage.today()),
    staleMemory: (await s.memory.stale()).length,
    pendingMemory: (await s.memory.pending()).length,
  }));

  // A bot as an API: send it a message from a script and get its reply when the turn ends (or the
  // turn's id to ask again later when the wait runs out).
  app.post('/api/bots/:id/ask', async (req, reply) => {
    const id = IdParams.parse(req.params).id;
    const body = z
      .object({
        text: z.string().trim().min(1).max(100_000),
        threadId: z.string().min(1).max(64).optional(),
        wait: z.number().int().min(0).max(600).default(300),
      })
      .parse(req.body);
    const result = await s.botApi.ask(id, body.text, { threadId: body.threadId, waitMs: body.wait * 1000 });
    return reply.code(result.status === 'running' ? 202 : 200).send(result);
  });
  app.get('/api/turns/:id/result', async (req, reply) => {
    const q = z.object({ wait: z.coerce.number().int().min(0).max(600).default(0) }).parse(req.query);
    const result = await s.botApi.result(IdParams.parse(req.params).id, q.wait * 1000);
    return reply.code(result.status === 'running' ? 202 : 200).send(result);
  });
  app.get('/api/usage/turns.csv', async (req, reply) => {
    const q = z
      .object({ days: z.coerce.number().int().default(30) })
      .refine((v) => (USAGE_RANGES as readonly number[]).includes(v.days), 'validation.usageRange')
      .parse(req.query);
    const csv = await s.usage.csv(q.days as UsageRange);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="yumakbot-usage-${q.days}d.csv"`)
      .send(csv);
  });

  // What the person's other AI tools on this computer have that YumakBot does not: skills and remote
  // MCP servers. Only when the server runs on the person's own computer, whose home folder it is.
  const foundSetup = async () =>
    findSetup({
      skills: (await s.skills.list()).map((k) => k.name),
      urls: (await s.connections.list()).map((c) => c.url),
    });
  app.get('/api/setup-import', async () => {
    if (!d.config.onUserComputer) return { available: false, skills: [], servers: [] };
    const found = await foundSetup();
    return {
      available: true,
      skills: found.skills.map(({ body: _b, ...k }) => k),
      servers: found.servers,
    };
  });
  // Folders the person's coding tools work in, each one a bot could be made to work in.
  app.get('/api/setup-import/projects', async () => {
    if (!d.config.onUserComputer) return { available: false, projects: [] };
    const bots = await s.bots.list({ includeArchived: true });
    const dirs = bots.map((b) => b.projectDir).filter((p): p is string => !!p);
    return { available: true, projects: await findProjects({ dirs }, { dataDir: d.config.dataDir }) };
  });
  app.post('/api/setup-import', async (req) => {
    if (!d.config.onUserComputer) throw new HttpError(404, 'error.notFound');
    const body = z
      .object({
        skills: z.array(z.string().max(64)).max(200).default([]),
        servers: z.array(z.string().max(2000)).max(100).default([]),
      })
      .parse(req.body);
    const found = await foundSetup();
    let skills = 0;
    let servers = 0;
    // Brought in switched off: no bot gets them until the person turns them on.
    for (const k of found.skills.filter((x) => body.skills.includes(x.name))) {
      await s.skills.create({ name: k.name, description: k.description, body: k.body, botIds: [] });
      skills++;
    }
    for (const c of found.servers.filter((x) => body.servers.includes(x.url))) {
      await s.connections.create({
        name: c.name,
        url: c.url,
        auth: 'none',
        catalogId: null,
        allBots: false,
        botIds: [],
      });
      servers++;
    }
    return { skills, servers };
  });
  // Content sealed at rest: the switch, and how far the stored rows are converted.
  app.get('/api/content-encryption', async () => s.contentSeal.status());
  app.put('/api/content-encryption', async (req) => {
    await s.contentSeal.set(z.object({ on: z.boolean() }).parse(req.body).on);
    return s.contentSeal.status();
  });

  // Teaching a task by showing it in the bot's browser; the steps come back as a skill draft.
  app.post('/api/bots/:id/teach', async (req) => {
    const bot = await s.bots.get(IdParams.parse(req.params).id);
    if (!d.services.ctx.browser.available) throw new HttpError(409, 'error.teachNoBrowser');
    await d.services.ctx.browser.startTeaching(bot.id);
    return { steps: 0 };
  });
  app.get('/api/bots/:id/teach', async (req) => ({
    steps: d.services.ctx.browser.teaching(IdParams.parse(req.params).id),
  }));
  app.post('/api/bots/:id/teach/stop', async (req) => {
    const bot = await s.bots.get(IdParams.parse(req.params).id);
    const { goal } = z.object({ goal: z.string().trim().max(500).default('') }).parse(req.body ?? {});
    const steps = d.services.ctx.browser.stopTeaching(bot.id);
    if (!steps?.length) throw new HttpError(409, 'error.teachNothing');
    const t = await s.settings.translator();
    const tr = t as unknown as (key: string, params?: Record<string, string | number>) => string;
    const description = goal || t('teach.defaultGoal');
    return {
      name: skillSlug(goal) || 'taught-task',
      description,
      body: [t('teach.intro', { goal: description }), '', stepsText(steps, tr), '', t('teach.outro')].join(
        '\n',
      ),
      steps: steps.length,
    };
  });

  // Bots' tables: the person reads, corrects and clears what a bot keeps there.
  app.get('/api/bots/:id/tables', async (req) => s.tables.list(IdParams.parse(req.params).id));
  app.get('/api/tables/:id/rows', async (req) => s.tables.rows(IdParams.parse(req.params).id));
  app.get('/api/tables/:id/rows.csv', async (req, reply) => {
    const t = await s.settings.translator();
    const { name, text } = await s.tables.csv(
      IdParams.parse(req.params).id,
      t('tool.tableYes'),
      t('tool.tableNo'),
    );
    // The table's own name, in any letters, with a plain fallback for older clients.
    const file = `${name.replace(/[\\/:*?"<>|]|\p{Cc}/gu, '_')}.csv`;
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header(
        'content-disposition',
        `attachment; filename="table.csv"; filename*=UTF-8''${encodeURIComponent(file)}`,
      )
      .send(text);
  });
  app.post('/api/tables/:id/rows', async (req) =>
    s.tables.addRows(IdParams.parse(req.params).id, [RowValues.parse(req.body)]).then((r) => r[0]),
  );
  app.patch('/api/tables/:id/rows/:rowId', async (req) => {
    const p = z.object({ id: z.string(), rowId: z.string() }).parse(req.params);
    return s.tables.updateRow(p.id, p.rowId, RowValues.parse(req.body));
  });
  app.delete('/api/tables/:id/rows/:rowId', async (req) => {
    const p = z.object({ id: z.string(), rowId: z.string() }).parse(req.params);
    return { deleted: await s.tables.deleteRows(p.id, [p.rowId]) };
  });
  app.delete('/api/tables/:id', async (req) => {
    await s.tables.remove(IdParams.parse(req.params).id);
    return { ok: true };
  });

  // The board: tickets the person and the bots work from.
  app.get('/api/tickets', async () => s.tickets.list());
  app.post('/api/tickets', async (req) => s.tickets.create(TicketCreate.parse(req.body)));
  app.patch('/api/tickets/:id', async (req) =>
    s.tickets.update(IdParams.parse(req.params).id, TicketUpdate.parse(req.body)),
  );
  app.delete('/api/tickets/:id', async (req) => {
    await s.tickets.remove(IdParams.parse(req.params).id);
    return { ok: true };
  });
  app.post('/api/tickets/:id/comments', async (req) =>
    s.tickets.comment(IdParams.parse(req.params).id, TicketCommentCreate.parse(req.body).text),
  );

  // Plugins: read first, so the person sees what each would add, then installed as connections
  // and skills.
  app.post('/api/plugins/preview', async (req) =>
    s.plugins.preview(z.object({ url: z.string().min(1).max(2000) }).parse(req.body).url),
  );
  app.post('/api/plugins/install', async (req) => s.plugins.install(PluginInstall.parse(req.body)));
  app.get('/api/skills', async () => s.skills.list());
  app.post('/api/skills', async (req) => s.skills.create(SkillCreate.parse(req.body)));
  // A skill file from a link (a GitHub page of a SKILL.md, or any https address); read here, so
  // the page is not stopped by the other site's rules on who may read it.
  app.post('/api/skills/fetch', async (req) =>
    fetchSkillFile(z.object({ url: z.string().min(1).max(2000) }).parse(req.body).url),
  );
  app.patch('/api/skills/:id', async (req) =>
    s.skills.update(IdParams.parse(req.params).id, SkillUpdate.parse(req.body)),
  );
  app.delete('/api/skills/:id', async (req) => {
    await s.skills.remove(IdParams.parse(req.params).id);
    return { ok: true };
  });
  app.put('/api/skills/:id/bots/:botId', async (req) => {
    const p = z.object({ id: z.string().min(1), botId: z.string().min(1) }).parse(req.params);
    await s.skills.get(p.id);
    await s.skills.setBot(p.id, p.botId, SkillBot.parse(req.body).on);
    return s.skills.get(p.id);
  });

  app.get('/api/groups', async () => s.bots.listGroups());
  app.post('/api/groups', async (req) => s.bots.createGroup(GroupCreate.parse(req.body).name));
  app.patch('/api/groups/:id', async (req) =>
    s.bots.renameGroup(IdParams.parse(req.params).id, GroupCreate.parse(req.body).name),
  );
  app.post('/api/groups/:id/move', async (req) =>
    s.bots.moveGroup(IdParams.parse(req.params).id, GroupMove.parse(req.body)),
  );
  app.delete('/api/groups/:id', async (req) => {
    await s.bots.deleteGroup(IdParams.parse(req.params).id);
    return { ok: true };
  });

  // Threads and messages
  app.get('/api/bots/:id/threads', async (req) => s.threads.list(IdParams.parse(req.params).id));
  app.get('/api/bots/:id/main-thread', async (req) => {
    const id = IdParams.parse(req.params).id;
    await s.bots.get(id);
    return s.threads.main(id);
  });
  app.post('/api/bots/:id/threads', async (req) => {
    const id = IdParams.parse(req.params).id;
    await s.bots.get(id);
    return s.threads.create(id, { title: ThreadCreate.parse(req.body ?? {}).title });
  });
  app.get('/api/threads/:id', async (req) => s.threads.get(IdParams.parse(req.params).id));
  app.patch('/api/threads/:id', async (req) => {
    const id = IdParams.parse(req.params).id;
    const body = z
      .object({
        title: z.string().max(120).optional(),
        goal: z.string().trim().max(2000).optional(),
        archived: z.boolean().optional(),
        /** Until when it stays out of the list; null brings it back. */
        snoozedUntil: z.iso
          .datetime({ offset: true })
          .refine((v) => new Date(v).getTime() > Date.now(), 'validation.snoozeFuture')
          .nullable()
          .optional(),
        pinned: z.boolean().optional(),
        /** One emoji (with its joiners and modifiers), or '' for none. */
        icon: z
          .string()
          .max(16)
          .refine((v) => v === '' || /^\p{Extended_Pictographic}/u.test(v), 'validation.emoji')
          .optional(),
      })
      .parse(req.body);
    if (body.icon !== undefined) await s.threads.setIcon(id, body.icon);
    if (body.title !== undefined) await s.threads.rename(id, body.title);
    if (body.archived !== undefined) await s.threads.archive(id, body.archived);
    if (body.snoozedUntil !== undefined)
      await s.threads.snooze(id, body.snoozedUntil ? new Date(body.snoozedUntil) : null);
    if (body.pinned !== undefined) await s.threads.pinInList(id, body.pinned);
    if (body.goal !== undefined) await s.threads.setGoal(id, body.goal);
    return s.threads.get(id);
  });
  /** Deletes a conversation with its turns, its folder and its staged uploads. */
  const deleteThread = async (id: string, botId: string) => {
    await s.turns.interrupt(id);
    await s.threads.remove(id);
    // The conversation's own folder (its attachments and what the bot made there) goes with it.
    const root = join(d.config.dataDir, 'workspaces', 'bots', botId, 'threads');
    await rm(join(root, id), { recursive: true, force: true }).catch(() => {});
    await rm(join(d.config.dataDir, 'uploads', id), { recursive: true, force: true }).catch(() => {});
  };
  app.delete('/api/threads/:id', async (req) => {
    const id = IdParams.parse(req.params).id;
    const { botId } = await s.threads.row(id);
    await deleteThread(id, botId);
    return { ok: true };
  });
  // Every conversation of a bot but its main one: a clean slate without losing the bot.
  app.delete('/api/bots/:id/threads', async (req) => {
    const id = IdParams.parse(req.params).id;
    await s.bots.get(id);
    const main = await s.threads.main(id);
    const others = (await s.threads.list(id)).filter((th) => th.id !== main.id);
    for (const th of others) await deleteThread(th.id, id);
    return { deleted: others.length };
  });
  app.get('/api/threads/:id/messages', async (req) => {
    const id = IdParams.parse(req.params).id;
    const { before } = z.object({ before: z.string().max(100).optional() }).parse(req.query);
    await s.threads.row(id);
    return s.threads.messages(id, { before });
  });
  app.post('/api/threads/:id/messages', async (req, reply) => {
    const id = IdParams.parse(req.params).id;
    const thread = await s.threads.row(id);
    // A room has its members answer in turn, not the one bot its thread points at.
    if (thread.kind === 'room') {
      const { message, created } = await s.rooms.post(id, RoomSend.parse(req.body));
      return reply.code(created ? 201 : 200).send(message);
    }
    const body = SendMessage.parse(req.body);
    const { message, created } = await s.inbox.send(id, body);
    return reply.code(created ? 201 : 200).send(message);
  });

  /** A message still waiting for its turn, or a 409 once the bot has started on it. */
  const queuedMessage = async (id: string) => {
    const m = await s.threads.message(id);
    if (m.role !== 'user' || m.author !== 'user' || !m.turnId || !m.props.queued) {
      throw new HttpError(409, 'error.messageStarted');
    }
    return m;
  };

  // Change a message the bot has not started on yet; its turn takes the new text.
  app.patch('/api/messages/:id', async (req) => {
    const m = await queuedMessage(IdParams.parse(req.params).id);
    const { text } = z.object({ text: z.string().max(100_000) }).parse(req.body);
    const files = (m.props.files as { name: string }[] | undefined) ?? [];
    if (!text.trim() && !files.length) throw new HttpError(400, 'validation.emptyMessage');
    const thread = await s.threads.row(m.threadId);
    const bot = await s.bots.get(thread.botId);
    const quotedId = (m.props.replyTo as { id?: string } | undefined)?.id;
    const answered = quotedId ? await s.threads.message(quotedId).catch(() => undefined) : undefined;
    const prompt = await s.inbox.prompt(text.trim(), s.inbox.threadDir(bot, m.threadId), files, answered);
    if (!(await s.turns.editQueued(m.turnId!, prompt))) throw new HttpError(409, 'error.messageStarted');
    await s.threads.editText(m.id, text.trim());
    return s.threads.message(m.id);
  });

  // Hand a waiting message to the turn running now, so the bot reads it at its next step.
  app.post('/api/messages/:id/steer', async (req) => {
    const m = await queuedMessage(IdParams.parse(req.params).id);
    if (!(await s.turns.steer(m.threadId, m.turnId!, m.id))) throw new HttpError(409, 'error.nothingRunning');
    return s.threads.message(m.id);
  });

  // Take back a message the bot has not started on yet, or remove one from the conversation.
  // A removed message leaves the chat; what the bot already read of it stays in its memory of
  // the conversation. Cards and bot-to-bot markers stay: they belong to work under way.
  // Runs again the request a failed or stopped turn left unanswered.
  app.post('/api/messages/:id/retry', async (req) => {
    const turn = await s.turns.retry(IdParams.parse(req.params).id);
    if (!turn) throw new HttpError(409, 'error.cannotRetry');
    return { ok: true, turnId: turn.id };
  });
  app.delete('/api/messages/:id', async (req) => {
    const id = IdParams.parse(req.params).id;
    const m = await s.threads.message(id);
    if (m.props.queued) {
      const queued = await queuedMessage(id);
      if (!(await s.turns.cancelQueued(queued.turnId!))) throw new HttpError(409, 'error.messageStarted');
    } else if (m.role === 'approval' || m.role === 'marker') {
      throw new HttpError(409, 'error.messageKept');
    }
    await s.threads.removeMessage(m.id);
    return { ok: true };
  });

  // The person's emoji on a bot message. Once it settles the bot hears of it and may answer or stay quiet.
  app.put('/api/threads/:id/pin', async (req) => {
    const id = IdParams.parse(req.params).id;
    const { messageId } = z.object({ messageId: z.string().min(1).max(64).nullable() }).parse(req.body);
    await s.threads.pin(id, messageId);
    return s.threads.get(id);
  });
  // A new conversation from the start of this one up to a message, to try another way from there.
  app.post('/api/messages/:id/fork', async (req) => {
    const id = IdParams.parse(req.params).id;
    const m = await s.threads.message(id);
    const source = await s.threads.get(m.threadId);
    const t = await s.settings.translator();
    const title = t('thread.forkTitle', { title: source.title || t('thread.untitled') });
    return s.threads.fork(id, truncate(title, 120));
  });
  app.put('/api/messages/:id/reaction', async (req) => {
    const id = IdParams.parse(req.params).id;
    const { emoji } = MessageReaction.parse(req.body);
    if (emoji !== null && !EMOJI.test(emoji)) throw new HttpError(400, 'error.notOneEmoji');
    const m = await s.threads.message(id);
    if (m.role !== 'assistant') throw new HttpError(400, 'error.reactBotOnly');
    const updated = await s.threads.setReaction(id, emoji);
    s.reactions.changed(id);
    return updated;
  });

  // Files the person attaches wait in a staging folder; sending the message moves them into the
  // conversation's folder.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));
  // A recording from the message box's microphone button, as the browser made it.
  app.addContentTypeParser(/^audio\//, (_req, payload, done) => done(null, payload));
  app.get('/api/transcribe', async () => ({ available: await d.transcribe.available() }));
  // A reply read aloud by the speech service the settings name; the app plays it.
  app.get('/api/speech', async () => ({ available: await s.speech.available() }));
  app.post('/api/speech', async (req, reply) => {
    const { text } = z.object({ text: z.string().min(1).max(100_000) }).parse(req.body);
    const { audio, type } = await s.speech.speak(text);
    return reply.header('cache-control', 'no-store').type(type).send(audio);
  });
  app.post('/api/transcribe', async (req) => {
    if (!(req.body instanceof Readable)) throw new HttpError(415, 'error.uploadType');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req.body) {
      size += (chunk as Buffer).length;
      if (size > MAX_AUDIO_BYTES) {
        throw new HttpError(413, 'error.fileTooLarge', { max: Math.round(MAX_AUDIO_BYTES / 1024 / 1024) });
      }
      chunks.push(chunk as Buffer);
    }
    const { lang } = z.object({ lang: z.enum(LOCALES).optional() }).parse(req.query);
    const text = await d.transcribe.transcribe(
      Buffer.concat(chunks),
      String(req.headers['content-type'] ?? 'audio/webm'),
      lang,
    );
    return { text };
  });
  app.post('/api/threads/:id/files', async (req) => {
    const id = IdParams.parse(req.params).id;
    const { name } = z.object({ name: z.string().min(1).max(500) }).parse(req.query);
    if (!(req.body instanceof Readable)) throw new HttpError(415, 'error.uploadType');
    const thread = await s.threads.row(id);
    const bot = await s.bots.get(thread.botId);
    if (bot.archivedAt) throw new HttpError(409, 'error.botArchived');
    return saveUpload(stagingDir(d.config.dataDir, id), name, req.body);
  });
  // Removes a file attached in the composer but taken off (or left) before sending. Only staged
  // uploads: files already in the conversation folder are not reached from here.
  app.delete('/api/threads/:id/files/:name', async (req) => {
    const { id, name } = z.object({ id: z.string().min(1), name: FileName }).parse(req.params);
    await s.threads.row(id);
    const dir = stagingDir(d.config.dataDir, id);
    attachedFiles(dir, [name]);
    await rm(join(dir, name));
    return { ok: true };
  });
  // The bot starts this conversation afresh; refused while it is working on it.
  app.post('/api/threads/:id/reset', async (req) => {
    const id = IdParams.parse(req.params).id;
    if ((await s.threads.state(id)) !== 'idle') throw new HttpError(409, 'error.threadBusy');
    await s.threads.resetContext(id, await s.settings.translator());
    return { ok: true };
  });

  app.post('/api/threads/:id/stop', async (req) => {
    const id = IdParams.parse(req.params).id;
    const stopped = await s.turns.interrupt(id);
    // The work this bot handed to others stops with it.
    const teammates = await s.jobs.stopFrom(id);
    return { stopped: stopped || teammates > 0, teammates };
  });

  // Rooms: the person and several bots in one conversation. Its messages, cards and files are the
  // thread's own routes; a room's id is its thread's id.
  app.get('/api/rooms', async () => s.rooms.list());
  app.post('/api/rooms', async (req) => s.rooms.create(RoomCreate.parse(req.body)));
  app.get('/api/rooms/:id', async (req) => s.rooms.get(IdParams.parse(req.params).id));
  app.patch('/api/rooms/:id', async (req) =>
    s.rooms.update(IdParams.parse(req.params).id, RoomUpdate.parse(req.body)),
  );
  app.delete('/api/rooms/:id', async (req) => {
    await s.rooms.remove(IdParams.parse(req.params).id);
    return { ok: true };
  });
  app.post('/api/rooms/:id/messages', async (req, reply) => {
    const { message, created } = await s.rooms.post(IdParams.parse(req.params).id, RoomSend.parse(req.body));
    return reply.code(created ? 201 : 200).send(message);
  });
  app.post('/api/rooms/:id/stop', async (req) => ({
    stopped: await s.rooms.stop(IdParams.parse(req.params).id),
  }));

  // Bot-to-bot exchange behind a marker line: that one request, not the pair's whole history.
  app.get('/api/jobs/:id', async (req) => {
    const job = await s.jobs.get(IdParams.parse(req.params).id);
    return { job, messages: await s.jobs.exchange(job) };
  });
  app.get('/api/bots/:id/conversations', async (req) => {
    const id = IdParams.parse(req.params).id;
    const rows = await s.ctx.db.select().from(schema.threads).where(eq(schema.threads.peerBotId, id));
    return rows.map((r) => ({ threadId: r.id, botId: r.botId }));
  });

  // Approvals and rules
  app.get('/api/approvals', async (req) => {
    const q = z
      .object({ status: z.enum(['pending', 'allowed', 'denied', 'expired']).optional() })
      .parse(req.query);
    return s.approvals.list(q);
  });
  app.get('/api/approvals/:id', async (req) => s.approvals.get(IdParams.parse(req.params).id));
  app.post('/api/approvals/:id', async (req) =>
    s.approvals.answer(IdParams.parse(req.params).id, ApprovalDecision.parse(req.body)),
  );
  app.get('/api/rules', async () => s.approvals.rules());
  app.post('/api/rules', async (req) => s.approvals.addRule(PermissionRuleCreate.parse(req.body)));
  app.delete('/api/rules/:id', async (req) => {
    await s.approvals.removeRule(IdParams.parse(req.params).id);
    return { ok: true };
  });

  // Connections: remote MCP servers. Tokens and secrets are write-only.
  const redirectUrl = (req: FastifyRequest) =>
    d.config.publicUrl
      ? `${d.config.publicUrl}${OAUTH_CALLBACK_PATH}`
      : oauthRedirectUrl({
          protocol: req.protocol,
          host: req.headers.host ?? req.host,
          forwardedProto: req.headers['x-forwarded-proto'],
          secure: d.config.secureCookies,
        });
  const ToolParams = z.object({ id: z.string().min(1), name: z.string().min(1).max(500) });
  app.get('/api/connections', async () => s.connections.list());
  app.get('/api/connections/redirect-url', async (req) => ({ url: redirectUrl(req) }));
  app.post('/api/connections', async (req) => s.connections.create(ConnectionCreate.parse(req.body)));
  app.get('/api/connections/:id', async (req) => s.connections.get(IdParams.parse(req.params).id));
  app.patch('/api/connections/:id', async (req) =>
    s.connections.update(IdParams.parse(req.params).id, ConnectionUpdate.parse(req.body)),
  );
  app.delete('/api/connections/:id', async (req) => {
    await s.connections.remove(IdParams.parse(req.params).id);
    return { ok: true };
  });
  app.post('/api/connections/:id/refresh', async (req) =>
    s.connections.refresh(IdParams.parse(req.params).id),
  );
  app.post('/api/connections/:id/signin', async (req) =>
    s.connections.startSignIn(IdParams.parse(req.params).id, redirectUrl(req)),
  );
  app.post('/api/connections/:id/signout', async (req) =>
    s.connections.signOut(IdParams.parse(req.params).id),
  );
  app.patch('/api/connections/:id/tools/:name', async (req) => {
    const { id, name } = ToolParams.parse(req.params);
    return s.connections.setTool(id, name, ConnectionToolPatch.parse(req.body));
  });
  app.put('/api/connections/:id/bots', async (req) =>
    s.connections.setBots(IdParams.parse(req.params).id, ConnectionBots.parse(req.body)),
  );
  // The service sends the person's browser back here, without the app's cookie: the one-time
  // state stands for the session that began the sign-in.
  app.get(OAUTH_CALLBACK_PATH, async (req, reply) => {
    const q = z
      .object({
        state: z.string().max(200).default(''),
        code: z.string().max(4000).optional(),
        error: z.string().max(500).optional(),
        error_description: z.string().max(1000).optional(),
      })
      .parse(req.query);
    const t = await s.settings.translator();
    let ok = true;
    let text: string;
    try {
      const name = await s.connections.finishSignIn({
        state: q.state,
        code: q.code,
        error: q.error ? `(${[q.error, q.error_description].filter(Boolean).join(': ')})` : undefined,
      });
      text = t('connection.page.done', { name });
    } catch (err) {
      ok = false;
      text = err instanceof HttpError ? err.localized(t) : (err as Error).message;
    }
    return reply
      .code(ok ? 200 : 400)
      .header('content-type', 'text/html; charset=utf-8')
      .header('content-security-policy', PLAIN_PAGE_POLICY)
      .header('cache-control', 'no-store')
      .send(
        callbackPage(
          t('connection.page.title'),
          ok ? text : t('connection.page.failed'),
          ok ? t('connection.page.doneHint') : text,
        ),
      );
  });

  // Password vault: sign-ins are listed without their passwords.
  // Model services besides the bots' own: embeddings for memory search, speech in and out.
  const AiKindParams = z.object({ kind: z.enum(AI_KINDS) });
  app.get('/api/ai-endpoints', async () => ({
    ...(await s.ai.all()),
    memoryIndex: await s.embeddings.status(),
  }));
  app.put('/api/ai-endpoints/:kind', async (req) =>
    s.ai.set(AiKindParams.parse(req.params).kind, AiEndpointSet.parse(req.body)),
  );
  app.delete('/api/ai-endpoints/:kind', async (req) => s.ai.clear(AiKindParams.parse(req.params).kind));
  app.post('/api/ai-endpoints/:kind/test', async (req) => {
    const { kind } = AiKindParams.parse(req.params);
    try {
      if (kind === 'embeddings') return { ok: true, detail: String((await s.embeddings.test()).dimensions) };
      if (kind === 'stt') return { ok: true, detail: await d.transcribe.test() };
      return { ok: true, detail: String((await s.speech.test()).bytes) };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  });

  // OpenAPI documents whose operations bots may call, with a saved API key.
  app.get('/api/api-sources', async () => s.apiSources.list());
  app.post('/api/api-sources', async (req) => s.apiSources.create(ApiSourceCreate.parse(req.body)));
  app.post('/api/api-sources/:id/refresh', async (req) =>
    s.apiSources.refresh(IdParams.parse(req.params).id),
  );
  app.delete('/api/api-sources/:id', async (req) => {
    await s.apiSources.remove(IdParams.parse(req.params).id);
    return { ok: true };
  });

  // API keys bots call services with; listed without their values.
  app.get('/api/api-keys', async () => s.apiCredentials.list());
  app.post('/api/api-keys', async (req) => s.apiCredentials.create(ApiCredentialCreate.parse(req.body)));
  app.patch('/api/api-keys/:id', async (req) =>
    s.apiCredentials.update(IdParams.parse(req.params).id, ApiCredentialUpdate.parse(req.body)),
  );
  app.delete('/api/api-keys/:id', async (req) => {
    await s.apiCredentials.remove(IdParams.parse(req.params).id);
    return { ok: true };
  });
  app.get('/api/vault', async () => s.vault.list());
  app.post('/api/vault', async (req) => s.vault.save(VaultLoginCreate.parse(req.body)));
  app.patch('/api/vault/:id', async (req) =>
    s.vault.update(IdParams.parse(req.params).id, VaultLoginUpdate.parse(req.body)),
  );
  app.delete('/api/vault/:id', async (req) => {
    await s.vault.remove(IdParams.parse(req.params).id);
    return { ok: true };
  });

  // Chat apps: a bot's own Telegram bot.
  app.get('/api/bots/:id/telegram', async (req) => s.telegram.status(IdParams.parse(req.params).id));
  app.put('/api/bots/:id/telegram', async (req) =>
    s.telegram.connect(IdParams.parse(req.params).id, TelegramConnect.parse(req.body).token),
  );
  app.patch('/api/bots/:id/telegram', async (req) =>
    s.telegram.update(IdParams.parse(req.params).id, TelegramUpdate.parse(req.body)),
  );
  app.post('/api/bots/:id/telegram/pair', async (req) => s.telegram.pair(IdParams.parse(req.params).id));
  app.delete('/api/bots/:id/telegram', async (req) => {
    await s.telegram.disconnect(IdParams.parse(req.params).id);
    return { ok: true };
  });

  // Chat apps: WhatsApp through a linked device, for whichever bot is chosen.
  app.get('/api/whatsapp', async () => s.whatsapp.status());
  app.put('/api/whatsapp', async (req) => s.whatsapp.configure(WhatsAppSet.parse(req.body)));
  app.post('/api/whatsapp/link', async () => s.whatsapp.link());
  app.delete('/api/whatsapp', async () => s.whatsapp.disconnect());

  // Memory
  app.get('/api/memory', async (req) => {
    const q = z
      .object({
        scope: z.enum(['bot', 'user']).optional(),
        botId: z.string().optional(),
      })
      .parse(req.query);
    return s.memory.list(q);
  });
  app.post('/api/memory', async (req) => {
    const b = MemoryCreate.parse(req.body);
    return s.memory.create({ ...b, source: 'user' });
  });
  app.patch('/api/memory/:id', async (req) =>
    s.memory.update(IdParams.parse(req.params).id, MemoryUpdate.parse(req.body), 'user'),
  );
  // Every note one bot keeps for itself.
  app.delete('/api/bots/:id/memory', async (req) =>
    s.memory.removeForBot(IdParams.parse(req.params).id, 'user'),
  );
  app.delete('/api/memory/:id', async (req) => {
    await s.memory.remove(IdParams.parse(req.params).id, 'user');
    return { ok: true };
  });
  app.get('/api/memory-history', async () => s.memory.history());
  // Memory changes bots asked for while nobody watched; they wait for the person.
  app.get('/api/memory-changes', async () => s.memory.pending());
  app.post('/api/memory-changes/:id/accept', async (req) => {
    const { content } = z.object({ content: z.string().trim().max(2000).optional() }).parse(req.body ?? {});
    await s.memory.accept(IdParams.parse(req.params).id, content);
    return { ok: true };
  });
  app.delete('/api/memory-changes/:id', async (req) => {
    await s.memory.reject(IdParams.parse(req.params).id);
    return { ok: true };
  });
  // Notes no bot uses any more, offered to the user to keep or delete.
  app.get('/api/memory-stale', async () => s.memory.stale());
  // Deletes the ones of `ids` that are still unused; a note a bot used since the list was shown stays.
  app.post('/api/memory-stale/delete', async (req) => {
    const { ids } = z.object({ ids: z.array(z.string().min(1).max(64)).max(5000) }).parse(req.body);
    const still = new Set((await s.memory.stale()).map((m) => m.id));
    return s.memory.removeMany(
      ids.filter((id) => still.has(id)),
      'user',
    );
  });

  // Routines
  // Bots exported from another assistant app, sent as the file itself. `preview` saves nothing.
  // The bots as an import file; `ids` picks some (comma separated), otherwise every active one.
  app.get('/api/export/bots', async (req, reply) => {
    const { ids } = z.object({ ids: z.string().max(20_000).optional() }).parse(req.query);
    const file = await s.botImport.export(ids ? ids.split(',').filter(Boolean) : undefined);
    const day = new Date().toISOString().slice(0, 10);
    reply.header('content-disposition', `attachment; filename="yumakbot-bots-${day}.json"`);
    return file;
  });
  app.post('/api/import/bots', async (req) => {
    const { preview } = z.object({ preview: z.enum(['1']).optional() }).parse(req.query);
    if (!(req.body instanceof Readable)) throw new HttpError(415, 'error.uploadType');
    const raw = await readJson(req.body, MAX_BOT_IMPORT_BYTES);
    return preview ? s.botImport.preview(raw) : s.botImport.commit(raw);
  });

  // A whole backup, sealed with a password: written on the server, then downloaded once.
  app.post('/api/backup', async (req) => {
    const { password } = z.object({ password: z.string().max(1000) }).parse(req.body);
    return d.backup.create(password);
  });
  app.get('/api/backup/:id', async (req, reply) => {
    const file = d.backup.path(IdParams.parse(req.params).id);
    if (!file) throw new HttpError(404, 'error.notFound');
    const day = new Date().toISOString().slice(0, 10);
    reply.header('content-disposition', `attachment; filename="yumakbot-backup-${day}.ybk"`);
    reply.header('content-length', statSync(file).size);
    reply.type('application/octet-stream');
    // One download: the file holds everything, so it does not wait on the server once fetched.
    reply.raw.once('finish', () => void rm(file, { force: true }));
    return reply.send(createReadStream(file));
  });
  // The password comes in a header, URI-encoded, since the body is the file itself.
  app.post('/api/backup/restore', async (req) => {
    if (!(req.body instanceof Readable)) throw new HttpError(415, 'error.uploadType');
    const raw = req.headers['x-backup-password'];
    let password = '';
    try {
      password = decodeURIComponent(typeof raw === 'string' ? raw : '');
    } catch {
      throw new HttpError(400, 'error.backupWrongPassword');
    }
    return d.backup.restore(req.body, password);
  });

  app.get('/api/routines', async (req) => {
    const q = z.object({ botId: z.string().optional() }).parse(req.query);
    return s.routines.list(q.botId);
  });
  app.post('/api/routines', async (req) => s.routines.create(RoutineCreate.parse(req.body)));
  app.patch('/api/routines/:id', async (req) =>
    s.routines.update(IdParams.parse(req.params).id, RoutineUpdate.parse(req.body)),
  );
  app.delete('/api/routines/:id', async (req) => {
    await s.routines.remove(IdParams.parse(req.params).id);
    return { ok: true };
  });
  // A script may start a routine and hand it some text: `{ "payload": "…" }`, or a text body.
  app.post('/api/routines/:id/failure-seen', async (req) => {
    await s.routines.failureSeen(IdParams.parse(req.params).id);
    return { ok: true };
  });
  app.post('/api/routines/:id/run', async (req) => {
    const body = req.body;
    const payload =
      typeof body === 'string'
        ? body
        : z
            .object({ payload: z.string().optional() })
            .catch({})
            .parse(body ?? {}).payload;
    if (payload !== undefined && payload.length > MAX_PAYLOAD) {
      throw new HttpError(413, 'error.payloadTooLarge', { max: MAX_PAYLOAD });
    }
    return s.routines.runNow(IdParams.parse(req.params).id, payload?.trim() || undefined);
  });
  app.post('/api/routines/:id/webhook', async (req) =>
    s.routines.setWebhook(IdParams.parse(req.params).id, true),
  );
  app.delete('/api/routines/:id/webhook', async (req) =>
    s.routines.setWebhook(IdParams.parse(req.params).id, false),
  );
  // A signed call is checked against the body exactly as it was sent, before it is parsed.
  app.addHook('preParsing', async (req, _reply, payload) => {
    if (req.method !== 'POST' || !req.url.startsWith(`${WEBHOOK_PATH}/`)) return payload;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of payload) {
      size += (chunk as Buffer).length;
      if (size > WEBHOOK_BODY_MAX)
        throw new HttpError(413, 'error.payloadTooLarge', { max: WEBHOOK_BODY_MAX });
      chunks.push(chunk as Buffer);
    }
    const raw = Buffer.concat(chunks);
    (req as { rawBody?: Buffer }).rawBody = raw;
    return Readable.from([raw]);
  });
  // A service without the access key starts a routine through its secret address. The request's
  // body, whatever it is, goes to the bot as data.
  app.post(`${WEBHOOK_PATH}/:id/:token`, async (req, reply) => {
    const p = z
      .object({ id: z.string().min(1).max(64), token: z.string().min(1).max(100) })
      .parse(req.params);
    const body = req.body;
    const raw =
      body === undefined || body === null
        ? ''
        : typeof body === 'string'
          ? body
          : JSON.stringify(body, null, 2);
    const payload = raw.length > MAX_PAYLOAD ? `${raw.slice(0, MAX_PAYLOAD)}…` : raw;
    // Senders that retry name each delivery; the same one sent again runs once.
    const header = (name: string) => {
      const v = req.headers[name];
      return typeof v === 'string' ? v : undefined;
    };
    const delivery =
      header('idempotency-key') ??
      header('x-github-delivery') ??
      header('webhook-id') ??
      header('x-webhook-id');
    // Code hosts name the kind of event in a header; GitHub also signs the body.
    const event = header('x-github-event') ?? header('x-gitlab-event') ?? header('x-event-key');
    const signature = header('x-hub-signature-256');
    const run = await s.routines.runFromWebhook(p.id, p.token, payload.trim() || undefined, delivery, {
      event,
      signature,
      raw: (req as { rawBody?: Buffer }).rawBody,
    });
    if (run === false) throw new HttpError(404, 'error.notFound');
    if (run === 'signature') throw new HttpError(401, 'error.webhookSignature');
    if (run === 'ping') return reply.code(200).send({ ok: true, runId: null, status: 'ping' });
    if (run === 'filtered' || run === 'duplicate')
      return reply.code(202).send({ ok: true, runId: null, status: run });
    // An earlier run is still going: the sender is asked to deliver this one again in a minute.
    if (run === 'busy')
      return reply.code(429).header('retry-after', '60').send({ ok: false, status: 'busy' });
    return reply.code(202).send({ ok: true, runId: run?.id ?? null, status: run?.status ?? 'skipped' });
  });
  app.get('/api/routines/:id/runs', async (req) => s.routines.runs(IdParams.parse(req.params).id));
  app.get('/api/routines/:id/revisions', async (req) => s.routines.revisions(IdParams.parse(req.params).id));

  // Library: files in the bot's folders (read-only listing and download).
  const libraryRoots = async (botId: string) => {
    const bot = await s.bots.get(botId);
    const root = resolve(d.config.dataDir, 'workspaces');
    const roots = [join(root, 'bots', bot.id)];
    if (bot.groupId) roots.push(join(root, 'groups', bot.groupId, 'files'));
    return { root, roots };
  };
  app.get('/api/bots/:id/library', async (req) => {
    const { root, roots } = await libraryRoots(IdParams.parse(req.params).id);
    const out: { path: string; name: string; size: number; modifiedAt: string }[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 6 || out.length > 500) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const full = join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) walk(full, depth + 1);
        else if (e.isFile()) {
          const st = statSync(full);
          out.push({
            path: relative(root, full),
            name: e.name,
            size: st.size,
            modifiedAt: st.mtime.toISOString(),
          });
        }
      }
    };
    for (const r of roots) walk(r, 0);
    return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  });
  /** A file in the bot's folders, resolved past symlinks so a link cannot point outside them. */
  const libraryFile = async (botId: string, path: string) => {
    const { root, roots } = await libraryRoots(botId);
    let full: string;
    try {
      full = realpathSync(resolve(root, path));
    } catch {
      throw new HttpError(404, 'error.fileMissing');
    }
    const realRoots = roots.flatMap((r) => {
      try {
        return [realpathSync(r)];
      } catch {
        return [];
      }
    });
    if (!realRoots.some((r) => full.startsWith(r + sep))) throw new HttpError(403, 'error.fileForbidden');
    const st = statSync(full);
    if (!st.isFile()) throw new HttpError(404, 'error.fileMissing');
    return { full, st };
  };

  // Several files of a message as one ZIP archive.
  app.get('/api/bots/:id/library/zip', async (req, reply) => {
    const botId = IdParams.parse(req.params).id;
    const q = z
      .object({
        path: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(100)]),
        name: z.string().max(100).optional(),
      })
      .parse(req.query);
    const paths = [...new Set(Array.isArray(q.path) ? q.path : [q.path])];
    const taken = new Set<string>();
    const entries = [];
    let total = 0;
    for (const p of paths) {
      const { full, st } = await libraryFile(botId, p);
      total += st.size;
      if (total > MAX_ZIP_BYTES) {
        throw new HttpError(413, 'error.fileTooLarge', { max: Math.round(MAX_ZIP_BYTES / 1024 / 1024) });
      }
      const name = uniqueName(basename(full), taken);
      taken.add(name);
      entries.push({ name, data: await readFile(full), modifiedAt: st.mtime });
    }
    const file = encodeURIComponent(`${(q.name ?? 'files').replace(/[\\/:*?"<>|]+/g, '-')}.zip`);
    reply.header('content-disposition', `attachment; filename*=UTF-8''${file}`);
    reply.header('x-content-type-options', 'nosniff');
    reply.type('application/zip');
    return reply.send(zip(entries));
  });

  /** The MCP app view a card in the conversation shows, with the bot whose turn showed it. */
  const appView = async (messageId: string) => {
    const m = await s.threads.message(messageId);
    const app = m.props.app as
      { id: string; connectionId: string; connect?: string[]; resources?: string[] } | undefined;
    if (!app || !/^[\w-]{1,64}$/.test(app.id) || !m.author.startsWith('bot:')) {
      throw new HttpError(404, 'error.notFound');
    }
    const bot = await s.bots.get(m.author.slice(4));
    const dir = workspacePaths(d.config.dataDir, bot.id, m.threadId, bot.groupId).threadDir;
    return { app, bot, file: join(dir, APP_DIR, `${app.id}.html`) };
  };
  // The view's page, to run in the app's sandboxed frame under the policy its server asked for.
  app.get('/api/apps/:id/frame', async (req, reply) => {
    const { app: view, file } = await appView(IdParams.parse(req.params).id);
    const html = await readFile(file, 'utf8').catch(() => {
      throw new HttpError(404, 'error.notFound');
    });
    const csp = frameCsp({ resources: view.resources, connect: view.connect, images: [] });
    return reply
      .header('content-security-policy', frameHeader(csp))
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer')
      .header('cache-control', 'no-cache')
      .type('text/html; charset=utf-8')
      .send(frameDocument(html, csp));
  });
  // A tool call the view makes: to its own connection only, as the bot that showed it may.
  app.post('/api/apps/:id/call', async (req) => {
    const { app: view, bot } = await appView(IdParams.parse(req.params).id);
    const body = z
      .object({ name: z.string().min(1).max(200), arguments: z.record(z.string(), z.unknown()).default({}) })
      .parse(req.body);
    return s.connections.callFromApp({
      connectionId: view.connectionId,
      bot,
      name: body.name,
      args: body.arguments,
    });
  });
  // A page a bot made, served to run in the app's sandboxed frame: scripts run, with an opaque
  // origin and a policy that lets it load only the usual libraries and fetch nothing.
  /**
   * A bot's page as a document of its own: scripts run sandboxed, with an opaque origin and a
   * policy that lets it load only the usual libraries and fetch nothing. `print` opens the print
   * dialog once it has drawn, so the person can save it as a PDF.
   */
  const sendPage = async (
    reply: FastifyReply,
    botId: string,
    path: string,
    o: { framed?: boolean; height?: number; print?: boolean; title?: string },
  ) => {
    const { full, st } = await libraryFile(botId, path);
    if (!/\.html?$/i.test(full) || st.size > 2 * 1024 * 1024) throw new HttpError(404, 'error.notFound');
    const csp = frameCsp({ resources: PAGE_LIBRARIES, images: ['https:'] });
    // Its own scripts, styles, pictures and data go inside it: the frame loads nothing from here.
    const page = await bundlePage(full);
    return reply
      .header('content-security-policy', frameHeader(csp, { print: o.print }))
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer')
      .header('cache-control', 'no-cache')
      .type('text/html; charset=utf-8')
      .send(
        frameDocument(page.html, csp, {
          reportSize: o.framed,
          fallbackHeight: o.height,
          print: o.print,
          title: o.title,
        }),
      );
  };
  // A page a bot made, served to run in the app's sandboxed frame, or opened on its own to print.
  app.get('/api/bots/:id/library/page', async (req, reply) => {
    const { path, h, print } = z
      .object({
        path: z.string().min(1),
        h: z.coerce.number().int().min(200).max(1200).optional(),
        print: z.enum(['1']).optional(),
      })
      .parse(req.query);
    return sendPage(reply, IdParams.parse(req.params).id, path, {
      framed: !print,
      height: h,
      print: !!print,
      title: print ? basename(path) : undefined,
    });
  });

  // Mail for the bots. A relay posts each message here with the secret; the person sets the domain
  // in the settings and gives bots their addresses.
  app.addContentTypeParser('message/rfc822', (_req, payload, done) => done(null, payload));
  app.post(EMAIL_INBOUND_PATH, async (req, reply) => {
    const { to } = z.object({ to: z.string().min(3).max(400) }).parse(req.query);
    if (!(req.body instanceof Readable)) throw new HttpError(415, 'error.uploadType');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req.body) {
      size += (chunk as Buffer).length;
      if (size > MAX_EMAIL_BYTES) {
        throw new HttpError(413, 'error.fileTooLarge', { max: Math.round(MAX_EMAIL_BYTES / 1024 / 1024) });
      }
      chunks.push(chunk as Buffer);
    }
    const auth = req.headers.authorization;
    const token = typeof auth === 'string' ? /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim() : undefined;
    // Every message accepted gets 200, kept or not, so the relay neither retries nor bounces it.
    const status = await s.email.receive(token, to, Buffer.concat(chunks));
    return reply.code(200).send({ ok: true, status });
  });
  app.get('/api/email', () => s.email.settings());
  app.post('/api/email/secret', () => s.email.renewSecret());
  app.post('/api/bots/:id/email', async (req) => {
    if (!(await s.email.domain())) throw new HttpError(409, 'error.emailNoDomain');
    return s.email.claim(IdParams.parse(req.params).id, EmailClaim.parse(req.body).name);
  });
  app.delete('/api/bots/:id/email', async (req) => {
    await s.email.release(IdParams.parse(req.params).id);
    return s.email.settings();
  });
  app.get('/api/bots/:id/emails', async (req) => s.email.inbox(IdParams.parse(req.params).id, { limit: 50 }));

  // Links that open a page for anyone who has them.
  app.get('/api/page-shares', () => s.pageShares.list());
  app.get('/api/bots/:id/library/share', async (req) => {
    const { path } = z.object({ path: z.string().min(1) }).parse(req.query);
    return { share: await s.pageShares.find(IdParams.parse(req.params).id, path) };
  });
  app.post('/api/bots/:id/library/share', async (req) => {
    const botId = IdParams.parse(req.params).id;
    const body = PageShareCreate.parse(req.body);
    // Only a page in the bot's own folders, and only an HTML page, can be shared.
    const { full } = await libraryFile(botId, body.path);
    if (!/\.html?$/i.test(full)) throw new HttpError(400, 'error.shareNotPage');
    return s.pageShares.share(botId, body.path, body.name);
  });
  app.delete('/api/page-shares/:token', async (req) => {
    const { token } = z.object({ token: z.string().min(1).max(100) }).parse(req.params);
    await s.pageShares.unshare(token);
    return { ok: true };
  });
  // The shared page itself: outside /api, so it opens without signing in. It runs sandboxed like
  // in the app, so it cannot reach this server with the visitor's sign-in either.
  app.get(`${SHARE_PATH}/:token`, async (req, reply) => {
    const { token } = z.object({ token: z.string().max(100) }).parse(req.params);
    const { print } = z.object({ print: z.enum(['1']).optional() }).parse(req.query);
    reply.header('x-robots-tag', 'noindex, nofollow');
    const share = await s.pageShares.resolve(token);
    try {
      if (share) return await sendPage(reply, share.botId, share.path, { print: !!print, title: share.name });
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      // The page was moved or deleted since it was shared: the link says it is gone, like an old link.
    }
    const t = translator(pickLocale(req.headers['accept-language'], await s.settings.locale()));
    return reply
      .code(404)
      .header('content-security-policy', PLAIN_PAGE_POLICY)
      .type('text/html; charset=utf-8')
      .send(callbackPage(t('share.gone.title'), t('share.gone.title'), t('share.gone.body')));
  });
  app.get('/api/bots/:id/library/file', async (req, reply) => {
    const { path, inline } = z
      .object({ path: z.string().min(1), inline: z.enum(['1']).optional() })
      .parse(req.query);
    const { full, st } = await libraryFile(IdParams.parse(req.params).id, path);
    // Only images, PDFs, sound and video are shown on the page; anything else (HTML included)
    // downloads, since the page could otherwise run it as its own.
    const type = inline ? INLINE_TYPES[extname(full).toLowerCase()] : undefined;
    // An SVG opened on its own would be a page of this site: it gets no scripts and no requests.
    if (type === 'image/svg+xml') {
      reply.header(
        'content-security-policy',
        "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
      );
    }
    const name = encodeURIComponent(basename(full));
    reply.header('content-disposition', `${type ? 'inline' : 'attachment'}; filename*=UTF-8''${name}`);
    reply.header('x-content-type-options', 'nosniff');
    // A bot may rewrite the file at any time; the preview asks again rather than trusting a copy.
    reply.header('cache-control', 'no-cache');
    reply.header('accept-ranges', 'bytes');
    reply.type(type ?? 'application/octet-stream');
    // A player asks for parts of the file to seek in it.
    const range = byteRange(req.headers.range, st.size);
    if (range) {
      reply.code(206);
      reply.header('content-range', `bytes ${range.start}-${range.end}/${st.size}`);
      reply.header('content-length', range.end - range.start + 1);
      return reply.send(createReadStream(full, range));
    }
    return reply.send(createReadStream(full));
  });
}

/** A request body read as JSON, refused past `max` bytes. */
async function readJson(body: Readable, max: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += (chunk as Buffer).length;
    if (size > max) throw new HttpError(413, 'error.fileTooLarge', { max: Math.round(max / 1024 / 1024) });
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(
      Buffer.concat(chunks)
        .toString('utf8')
        .replace(/^\uFEFF/, ''),
    ) as unknown;
  } catch {
    throw new HttpError(400, 'error.importFormat');
  }
}

const escapeHtml = (v: string) =>
  v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The small page the person's browser lands on after signing in to a service. */
function callbackPage(title: string, heading: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#fff;color:#111}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}}main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.25rem;font-weight:600}p{opacity:.75;line-height:1.5}</style></head><body><main><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(body)}</p></main></body></html>`;
}
