import { createHash } from 'node:crypto';
import {
  MAX_CONNECTIONS,
  catalogEntry,
  connectionSlug,
  sharesApp,
  type Connection,
  type ConnectionAuthStart,
  type ConnectionCreate,
  type ConnectionToolPatch,
  type ConnectionUpdate,
} from '@yumakbot/shared';
import { and, asc, eq, inArray, isNull, lt, ne, or } from 'drizzle-orm';
import {
  callTool,
  classify,
  ConnectionClientError,
  dropClient,
  finishOAuth,
  listTools,
  readAppResource,
  startOAuth,
  type AppResource,
  type ClientTarget,
  type ConnectionSecrets,
} from '../connections/client';
import type { CallToolResult, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import type { ElicitForm } from '../connections/elicit';
import type { Ctx } from '../context';
import { schema } from '../db';
import type { StoredConnectionTool } from '../db/schema';
import type { AppTool, ToolImage, ToolResult } from '../engine/types';
import type { T } from '../i18n';
import { HttpError, newId, truncate } from '../util';
import { serverTranslator } from './settings';
import type { VaultService } from './vault';

type Row = typeof schema.connections.$inferSelect;

/** What a tool's answer may hand the model, in characters. */
const MAX_RESULT = 25_000;
/** How much of an answer kept in a file comes with its path. */
const PREVIEW = 4_000;
/** A sign-in not finished in this time is forgotten. */
const SIGNIN_TTL_MS = 15 * 60_000;
/** Tool names models accept: letters, digits, `_` and `-`, at most 64 in all. */
const MAX_TOOL_NAME = 64;

export const OAUTH_CALLBACK_PATH = '/api/connections/oauth/callback';

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The OAuth callback as the app reaches this server. `host` is the already checked Host header.
 * Behind a TLS proxy the request arrives as plain HTTP, yet services refuse an `http://` callback
 * anywhere but on a loopback host, so a server set up for HTTPS (secure cookies) or told so by the
 * proxy names an `https://` callback. Loopback hosts keep the scheme the request came with.
 */
export function oauthRedirectUrl(req: {
  protocol: string;
  host: string;
  forwardedProto?: string | string[];
  secure: boolean;
}): string {
  const host = req.host.toLowerCase();
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]!;
  const forwarded = [req.forwardedProto].flat()[0]?.split(',')[0]?.trim().toLowerCase();
  const https = !LOOPBACK_NAMES.has(name) && (req.secure || forwarded === 'https');
  return `${https ? 'https' : req.protocol}://${req.host}${OAUTH_CALLBACK_PATH}`;
}

/**
 * The name a server's tool goes under for the model, unique within its connection and short
 * enough for `mcp__<slug>__<name>`. Kept stable for the same list, so rules that name it hold.
 */
export function exposedNames(slug: string, names: string[]): Map<string, string> {
  const room = MAX_TOOL_NAME - `mcp__${slug}__`.length;
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const name of names) {
    let base = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, room) || 'tool';
    if (used.has(base)) {
      const hash = createHash('sha1').update(name).digest('hex').slice(0, 6);
      base = `${base.slice(0, room - 7)}_${hash}`;
    }
    used.add(base);
    out.set(name, base);
  }
  return out;
}

/** The connections a person's work may use: the team's and their own. */
const usable = (userId: string) =>
  or(isNull(schema.connections.userId), eq(schema.connections.userId, userId))!;

export class ConnectionService {
  constructor(
    private ctx: Ctx,
    private vault: VaultService,
  ) {}

  // ------------------------------------------------------------------------------ reading

  private secretsOf(row: Pick<Row, 'secrets'>): ConnectionSecrets {
    if (!row.secrets) return {};
    try {
      return JSON.parse(this.vault.open(row.secrets)) as ConnectionSecrets;
    } catch {
      // Sealed with a key this server no longer has: as if never signed in.
      return {};
    }
  }

  private async row(id: string): Promise<Row> {
    const [row] = await this.ctx.db.select().from(schema.connections).where(eq(schema.connections.id, id));
    if (!row) throw new HttpError(404, 'error.notFound.connection');
    return row;
  }

  private async botIdsOf(ids: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>(ids.map((id) => [id, []]));
    if (!ids.length) return out;
    const rows = await this.ctx.db
      .select()
      .from(schema.botConnections)
      .where(inArray(schema.botConnections.connectionId, ids));
    for (const r of rows) out.get(r.connectionId)?.push(r.botId);
    return out;
  }

  private view(row: Row, botIds: string[]): Connection {
    const secrets = this.secretsOf(row);
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      catalogId: row.catalogId,
      url: row.url,
      auth: row.auth,
      status: row.status,
      error: row.error,
      hasToken: !!secrets.token,
      clientId: secrets.ownClient?.client_id ?? null,
      clientName: (secrets.ownClient && secrets.ownClientName) || null,
      tools: row.tools.map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        hinted: t.hinted,
        kind: t.kind ?? t.hinted,
        enabled: t.enabled,
        ...(t.ui && { app: true }),
      })),
      allBots: row.allBots,
      userId: row.userId,
      showApps: row.showApps,
      botIds: row.allBots ? [] : botIds,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** Every connection; with `userId`, the team's and that person's own. */
  async list(userId?: string): Promise<Connection[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.connections)
      .where(userId ? usable(userId) : undefined)
      .orderBy(asc(schema.connections.createdAt));
    const bots = await this.botIdsOf(rows.map((r) => r.id));
    return rows.map((r) => this.view(r, bots.get(r.id) ?? []));
  }

  async get(id: string): Promise<Connection> {
    const row = await this.row(id);
    return this.view(row, (await this.botIdsOf([id])).get(id) ?? []);
  }

  // ------------------------------------------------------------------------------ changing

  private target(row: Row): ClientTarget {
    let current = this.secretsOf(row);
    const version = `${row.url}|${row.auth}|${row.auth === 'token' ? (row.secrets ?? '') : ''}`;
    return {
      id: row.id,
      url: row.url,
      auth: row.auth,
      version,
      scope: catalogEntry(row.catalogId)?.scope,
      store: {
        get: () => current,
        save: async (next) => {
          current = next;
          await this.ctx.db
            .update(schema.connections)
            .set({ secrets: this.vault.seal(JSON.stringify(next)) })
            .where(eq(schema.connections.id, row.id));
        },
        reload: async () => {
          const [now] = await this.ctx.db
            .select({ secrets: schema.connections.secrets })
            .from(schema.connections)
            .where(eq(schema.connections.id, row.id));
          if (now) current = this.secretsOf(now);
        },
      },
    };
  }

  private sealed(secrets: ConnectionSecrets): string | null {
    return Object.keys(secrets).length ? this.vault.seal(JSON.stringify(secrets)) : null;
  }

  private changed() {
    this.ctx.bus.refresh({ scope: 'connections' });
  }

  /** A new connection: `userId`'s own, or the team's when null. */
  async create(
    input: ConnectionCreate & { catalogId: string | null; allBots: boolean; botIds: string[] },
    userId: string | null,
  ): Promise<Connection> {
    const all = await this.ctx.db.select({ slug: schema.connections.slug }).from(schema.connections);
    if (all.length >= MAX_CONNECTIONS)
      throw new HttpError(400, 'error.connectionLimit', { max: MAX_CONNECTIONS });
    const secrets: ConnectionSecrets = {};
    if (input.auth === 'token') {
      if (!input.token) throw new HttpError(400, 'error.connectionToken');
      secrets.token = input.token;
    }
    if (input.auth === 'oauth' && input.clientId) {
      secrets.ownClient = {
        client_id: input.clientId,
        ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
      };
      if (input.clientName) secrets.ownClientName = input.clientName;
    } else if (input.auth === 'oauth' && input.sameAppAs) {
      const sibling = await this.row(input.sameAppAs);
      // Another person's app registration is theirs: only the team's and one's own are shared.
      if (sibling.userId && sibling.userId !== userId) throw new HttpError(404, 'error.notFound.connection');
      if (!sharesApp(sibling, input)) throw new HttpError(400, 'error.connectionSibling');
      const { ownClient, ownClientName } = this.secretsOf(sibling);
      if (ownClient) secrets.ownClient = ownClient;
      if (ownClient && ownClientName) secrets.ownClientName = ownClientName;
    }
    const id = newId();
    await this.ctx.db.insert(schema.connections).values({
      id,
      userId,
      slug: connectionSlug(
        input.name,
        all.map((r) => r.slug),
      ),
      name: input.name,
      catalogId: catalogEntry(input.catalogId) ? input.catalogId : null,
      url: input.url,
      auth: input.auth,
      status: 'signed-out',
      secrets: this.sealed(secrets),
      allBots: input.allBots,
    });
    if (!input.allBots && input.botIds.length)
      await this.setBots(id, { allBots: false, botIds: input.botIds }, false);
    // A server that needs no sign-in, or has its token, is checked right away.
    if (input.auth !== 'oauth') await this.refresh(id);
    this.changed();
    return this.get(id);
  }

  async update(id: string, patch: ConnectionUpdate): Promise<Connection> {
    const row = await this.row(id);
    const secrets = this.secretsOf(row);
    const moved =
      (patch.url !== undefined && patch.url !== row.url) || (patch.auth && patch.auth !== row.auth);
    // Another server, or another way in: nothing of the old sign-in goes to it.
    const next: ConnectionSecrets = moved ? {} : { ...secrets };
    if (patch.token !== undefined) {
      if (patch.token) next.token = patch.token;
      else delete next.token;
    }
    if (patch.clientId !== undefined) {
      if (patch.clientId) {
        const keepSecret =
          patch.clientId === secrets.ownClient?.client_id ? secrets.ownClient?.client_secret : undefined;
        const secret = patch.clientSecret ?? keepSecret;
        next.ownClient = { client_id: patch.clientId, ...(secret ? { client_secret: secret } : {}) };
      } else delete next.ownClient;
      // Tokens from another app don't belong to this one, nor does its name.
      if (patch.clientId !== (secrets.ownClient?.client_id ?? '')) {
        delete next.oauth;
        delete next.ownClientName;
      }
    }
    const auth = patch.auth ?? row.auth;
    if (auth === 'token' && !next.token) throw new HttpError(400, 'error.connectionToken');
    await this.ctx.db
      .update(schema.connections)
      .set({
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.url !== undefined && { url: patch.url }),
        ...(patch.showApps !== undefined && { showApps: patch.showApps }),
        auth,
        secrets: this.sealed(next),
        // Another server's tool of the same name may do something else: its list starts over.
        ...(moved && { tools: [], status: 'signed-out' as const, error: null }),
        updatedAt: new Date(),
      })
      .where(eq(schema.connections.id, id));
    dropClient(id);
    const changedAccess = moved || patch.token !== undefined || patch.clientId !== undefined;
    if (changedAccess && auth !== 'oauth') await this.refresh(id);
    else if (changedAccess && auth === 'oauth') await this.setStatus(id, 'signed-out', null);
    this.changed();
    return this.get(id);
  }

  async remove(id: string) {
    await this.row(id);
    dropClient(id);
    await this.ctx.db.delete(schema.connections).where(eq(schema.connections.id, id));
    this.changed();
  }

  /**
   * Why an OAuth sign-in ended, kept so a sign-in that drops on its own says why. A wrong token
   * needs no more than the status.
   */
  private signOutReason(row: Pick<Row, 'auth'>, e: ConnectionClientError): string | null {
    return row.auth === 'oauth' ? truncate(e.message, 500) : null;
  }

  /** What went wrong, as the person reads it under the connection. */
  private async failureText(row: Pick<Row, 'url' | 'catalogId'>, e: ConnectionClientError): Promise<string> {
    if (e.code !== 'forbidden') return truncate(e.message, 500);
    const t = await serverTranslator(this.ctx);
    const key =
      catalogEntry(row.catalogId)?.client?.family === 'google'
        ? 'connection.forbiddenGoogle'
        : 'connection.forbidden';
    const said = e.message.replace(/^HTTP 403:?\s*/, '');
    return truncate(`${t(key, { host: new URL(row.url).host })}${said ? `\n${said}` : ''}`, 500);
  }

  private async setStatus(id: string, status: Row['status'], error: string | null) {
    await this.ctx.db
      .update(schema.connections)
      .set({ status, error, updatedAt: new Date() })
      .where(eq(schema.connections.id, id));
  }

  /** Lists the server's tools again; marks the connection by how that went. */
  async refresh(id: string): Promise<Connection> {
    const row = await this.row(id);
    try {
      const tools = await listTools(this.target(row), row.tools);
      await this.ctx.db
        .update(schema.connections)
        .set({ tools, status: 'connected', error: null, updatedAt: new Date() })
        .where(eq(schema.connections.id, id));
    } catch (err) {
      const e = classify(err);
      if (e.code === 'unauthorized') await this.setStatus(id, 'signed-out', this.signOutReason(row, e));
      else await this.setStatus(id, 'error', await this.failureText(row, e));
    }
    this.changed();
    return this.get(id);
  }

  async setTool(id: string, name: string, patch: ConnectionToolPatch): Promise<Connection> {
    const row = await this.row(id);
    if (!row.tools.some((t) => t.name === name)) throw new HttpError(404, 'error.notFound.connectionTool');
    const tools = row.tools.map((t) =>
      t.name === name
        ? {
            ...t,
            ...(patch.enabled !== undefined && { enabled: patch.enabled }),
            // The person calling a tool a read is kept even when the app says the same: for a
            // tool that takes an address, only their word makes it one where outside text could
            // be steering the bot.
            ...(patch.kind !== undefined && {
              kind: patch.kind === t.hinted && patch.kind !== 'read' ? null : patch.kind,
            }),
          }
        : t,
    );
    await this.ctx.db
      .update(schema.connections)
      .set({ tools, updatedAt: new Date() })
      .where(eq(schema.connections.id, id));
    this.changed();
    return this.get(id);
  }

  /** Opens a connection to every bot, or limits it to the given ones. */
  /** Gives a connection to a person, or to the team when null. */
  async setOwner(id: string, userId: string | null): Promise<Connection> {
    await this.row(id);
    await this.ctx.db.update(schema.connections).set({ userId }).where(eq(schema.connections.id, id));
    this.ctx.bus.refresh({ scope: 'connections' });
    return this.get(id);
  }

  async setBots(
    id: string,
    access: { allBots: boolean; botIds: string[] },
    notify = true,
  ): Promise<Connection> {
    await this.row(id);
    const unique = access.allBots ? [] : [...new Set(access.botIds)];
    const known = unique.length
      ? await this.ctx.db
          .select({ id: schema.bots.id })
          .from(schema.bots)
          .where(inArray(schema.bots.id, unique))
      : [];
    if (known.length !== unique.length) throw new HttpError(404, 'error.notFound.bot');
    await this.ctx.db.transaction(async (tx) => {
      await tx
        .update(schema.connections)
        .set({ allBots: access.allBots })
        .where(eq(schema.connections.id, id));
      await tx.delete(schema.botConnections).where(eq(schema.botConnections.connectionId, id));
      if (unique.length)
        await tx.insert(schema.botConnections).values(unique.map((botId) => ({ botId, connectionId: id })));
    });
    if (notify) this.changed();
    return this.get(id);
  }

  // ------------------------------------------------------------------------------ sign-in

  /** Begins an OAuth sign-in; `redirectUrl` is this server's callback as the app reaches it. */
  async startSignIn(id: string, redirectUrl: string): Promise<ConnectionAuthStart> {
    const row = await this.row(id);
    if (row.auth !== 'oauth') return { url: null, connection: await this.refresh(id) };
    const entry = catalogEntry(row.catalogId);
    if (entry?.client && !this.secretsOf(row).ownClient && !entry.client.secretOptional) {
      throw new HttpError(400, 'error.connectionNeedsClient');
    }
    const target = this.target(row);
    // Asked to sign in while not connected: a kept token would only be renewed and turned down
    // as before, so the sign-in starts afresh, with a new consent.
    const kept = this.secretsOf(row);
    if (row.status !== 'connected' && kept.oauth?.tokens) {
      const oauth = { ...kept.oauth };
      delete oauth.tokens;
      await target.store.save({ ...kept, oauth });
      dropClient(id);
    }
    let started;
    try {
      started = await startOAuth(target, redirectUrl);
    } catch (err) {
      const e = classify(err);
      await this.setStatus(id, 'error', truncate(e.message, 500));
      this.changed();
      throw new HttpError(502, 'error.connectionSignIn', { message: truncate(e.message, 300) });
    }
    if (!started) return { url: null, connection: await this.refresh(id) };
    await this.ctx.db
      .delete(schema.connectionSignins)
      .where(lt(schema.connectionSignins.createdAt, new Date(Date.now() - SIGNIN_TTL_MS)));
    await this.ctx.db.insert(schema.connectionSignins).values({
      state: started.state,
      connectionId: id,
      verifier: this.vault.seal(started.verifier),
      redirectUrl,
    });
    return { url: started.url, connection: await this.get(id) };
  }

  /** Finishes a sign-in the service sent back to the callback. Returns the connection's name. */
  async finishSignIn(input: { state: string; code?: string; error?: string }): Promise<string> {
    const [pending] = await this.ctx.db
      .select()
      .from(schema.connectionSignins)
      .where(eq(schema.connectionSignins.state, input.state));
    if (!pending || pending.createdAt.getTime() < Date.now() - SIGNIN_TTL_MS) {
      throw new HttpError(400, 'error.connectionSignInExpired');
    }
    // A state is good for one answer.
    await this.ctx.db.delete(schema.connectionSignins).where(eq(schema.connectionSignins.state, input.state));
    const row = await this.row(pending.connectionId);
    if (input.error || !input.code) {
      throw new HttpError(400, 'error.connectionSignInRefused', {
        message: truncate(input.error ?? '', 200),
      });
    }
    try {
      await finishOAuth(this.target(row), pending.redirectUrl, this.vault.open(pending.verifier), input.code);
    } catch (err) {
      const e = classify(err);
      await this.setStatus(row.id, 'signed-out', truncate(e.message, 500));
      this.changed();
      throw new HttpError(502, 'error.connectionSignIn', { message: truncate(e.message, 300) });
    }
    await this.refresh(row.id);
    return row.name;
  }

  async signOut(id: string): Promise<Connection> {
    const row = await this.row(id);
    const secrets = this.secretsOf(row);
    // The person's own OAuth app is a setting of theirs and stays.
    const next: ConnectionSecrets = secrets.ownClient
      ? {
          ownClient: secrets.ownClient,
          ...(secrets.ownClientName ? { ownClientName: secrets.ownClientName } : {}),
        }
      : {};
    await this.ctx.db
      .update(schema.connections)
      .set({ secrets: this.sealed(next), status: 'signed-out', error: null, updatedAt: new Date() })
      .where(eq(schema.connections.id, id));
    dropClient(id);
    this.changed();
    return this.get(id);
  }

  // ------------------------------------------------------------------------------ tools for bots

  /** Each connection's name by the name its tools go under. */
  async names(): Promise<Map<string, string>> {
    const rows = await this.ctx.db
      .select({ slug: schema.connections.slug, name: schema.connections.name })
      .from(schema.connections);
    return new Map(rows.map((r) => [r.slug, r.name]));
  }

  private appPages = new Map<string, { page: AppResource | null; at: number }>();

  /** A tool's view page, kept ten minutes: the same view is shown at every call of its tool. */
  private async appResource(row: Row, uri: string): Promise<AppResource | null> {
    const key = `${row.id}|${uri}`;
    const known = this.appPages.get(key);
    if (known && Date.now() - known.at < 10 * 60_000) return known.page;
    const page = await readAppResource(this.target(row), uri);
    this.appPages.set(key, { page, at: Date.now() });
    return page;
  }

  /**
   * A call a tool's view makes from the conversation. Only to its own connection, open to the bot
   * whose turn showed it; a tool that reads runs, any other only for a bot allowed to act without
   * asking, the way the bot's own call would have gone without a card.
   */
  async callFromApp(o: {
    connectionId: string;
    bot: { id: string; permissionMode: string };
    name: string;
    args: Record<string, unknown>;
    /** The person using the app: a connection of someone else's is not theirs to call. */
    userId: string;
  }): Promise<CallToolResult> {
    const row = await this.row(o.connectionId);
    if (row.userId && row.userId !== o.userId) throw new HttpError(403, 'error.appUnavailable');
    if (row.status !== 'connected') throw new HttpError(409, 'error.appUnavailable');
    if (!row.allBots) {
      const [open] = await this.ctx.db
        .select()
        .from(schema.botConnections)
        .where(
          and(eq(schema.botConnections.botId, o.bot.id), eq(schema.botConnections.connectionId, row.id)),
        );
      if (!open) throw new HttpError(403, 'error.appUnavailable');
    }
    const tool = row.tools.find((x) => x.name === o.name && x.enabled);
    if (!tool) throw new HttpError(404, 'error.notFound');
    if ((tool.kind ?? tool.hinted) !== 'read' && o.bot.permissionMode !== 'auto') {
      throw new HttpError(403, 'error.appCallAsks');
    }
    return callTool(
      this.target(row),
      tool.name,
      o.args,
      AbortSignal.timeout(this.ctx.config.mcpCallTimeoutMs),
    );
  }

  /**
   * The tool a routine's check may call for a bot: of a connected app open to the bot, switched on,
   * and one that only reads. Null when it is not such a tool.
   */
  async checkTool(botId: string, connectionId: string, name: string, userId: string) {
    const [row] = await this.ctx.db
      .select()
      .from(schema.connections)
      .where(and(eq(schema.connections.id, connectionId), usable(userId)));
    if (!row) return null;
    if (!row.allBots) {
      const [open] = await this.ctx.db
        .select()
        .from(schema.botConnections)
        .where(and(eq(schema.botConnections.botId, botId), eq(schema.botConnections.connectionId, row.id)));
      if (!open) return null;
    }
    const tool = row.tools.find((x) => x.name === name && x.enabled && !x.appOnly);
    if (!tool || (tool.kind ?? tool.hinted) !== 'read') return null;
    return { row, tool };
  }

  /**
   * The app tool a bot names the way it sees it (`mcp__<app>__<tool>`), as a routine's check: the
   * connection and the tool's own name, when it is one `checkTool` allows.
   */
  async checkFromName(
    botId: string,
    exposed: string,
    userId: string,
  ): Promise<{ connectionId: string; tool: string } | null> {
    // Claude sees an app's tool as `mcp__<app>__<tool>`; other engines see the tool's name alone.
    const m = /^mcp__([a-z0-9_]+?)__(.+)$/.exec(exposed);
    const rows = await this.ctx.db
      .select()
      .from(schema.connections)
      .where(m ? eq(schema.connections.slug, m[1]!) : undefined)
      .orderBy(asc(schema.connections.createdAt));
    const want = m ? m[2]! : exposed;
    const found: { connectionId: string; tool: string }[] = [];
    for (const row of rows) {
      const names = exposedNames(
        row.slug,
        row.tools.map((x) => x.name),
      );
      const tool = row.tools.find((x) => names.get(x.name) === want || x.name === want);
      if (tool && (await this.checkTool(botId, row.id, tool.name, userId)))
        found.push({ connectionId: row.id, tool: tool.name });
    }
    // Two apps with a tool of that name: the bot has to say which, with the app's part.
    return found.length === 1 ? found[0]! : null;
  }

  /**
   * Calls a routine's check, with no one watching: only a tool `checkTool` allows. Returns the
   * app's name and the answer as text; throws when the call cannot be made or the tool failed.
   */
  async callCheck(
    botId: string,
    check: { connectionId: string; tool: string; args: Record<string, unknown> },
    userId: string,
  ) {
    const found = await this.checkTool(botId, check.connectionId, check.tool, userId);
    if (!found) throw new HttpError(400, 'error.routineCheckTool');
    if (found.row.status !== 'connected') throw new HttpError(409, 'error.appUnavailable');
    const result = await callTool(
      this.target(found.row),
      found.tool.name,
      check.args,
      AbortSignal.timeout(this.ctx.config.mcpCallTimeoutMs),
    );
    const text = resultText(result);
    if (result.isError) throw new Error(truncate(text, 500));
    return { app: found.row.name, text };
  }

  /** The connections open to a bot that are not usable now, with why: their tools are left out. */
  async unavailableFor(
    botId: string,
    userId: string,
  ): Promise<{ name: string; status: 'signed-out' | 'error' }[]> {
    const chosen = this.ctx.db
      .select({ id: schema.botConnections.connectionId })
      .from(schema.botConnections)
      .where(eq(schema.botConnections.botId, botId));
    const rows = await this.ctx.db
      .select({ name: schema.connections.name, status: schema.connections.status })
      .from(schema.connections)
      .where(
        and(
          ne(schema.connections.status, 'connected'),
          usable(userId),
          or(eq(schema.connections.allBots, true), inArray(schema.connections.id, chosen)),
        ),
      )
      .orderBy(asc(schema.connections.createdAt));
    return rows.flatMap((r) => (r.status === 'connected' ? [] : [{ name: r.name, status: r.status }]));
  }

  /**
   * Tries again the connections that failed (a server down for a moment, a local one started after
   * this one) at least `minAgeMs` ago, so they come back without the person pressing Refresh.
   * Signed-out ones wait for the person: only a new sign-in helps them.
   */
  async retryFailed(minAgeMs: number): Promise<number> {
    const rows = await this.ctx.db
      .select({ id: schema.connections.id })
      .from(schema.connections)
      .where(
        and(
          eq(schema.connections.status, 'error'),
          lt(schema.connections.updatedAt, new Date(Date.now() - minAgeMs)),
        ),
      );
    for (const r of rows) await this.refresh(r.id).catch((err) => console.warn('connection retry', err));
    return rows.length;
  }

  /** The tools of the connections open to a bot, as the bot's own tools. */
  /** `elicit` answers a server that asks the person something during a call. */
  async toolsFor(
    botId: string,
    /** The person the bot works for: the team's connections and their own. */
    userId: string,
    t: T,
    signal: AbortSignal,
    elicit?: TurnElicit,
    /** Keeps an answer too long for the model as a file the bot can read; returns where it went. */
    keep?: KeepResult,
    /** Shows a tool's own view (an MCP app) in the conversation after it was called. */
    showApp?: ShowApp,
  ): Promise<AppTool[]> {
    const chosen = this.ctx.db
      .select({ id: schema.botConnections.connectionId })
      .from(schema.botConnections)
      .where(eq(schema.botConnections.botId, botId));
    const rows = await this.ctx.db
      .select()
      .from(schema.connections)
      .where(
        and(
          eq(schema.connections.status, 'connected'),
          usable(userId),
          or(eq(schema.connections.allBots, true), inArray(schema.connections.id, chosen)),
        ),
      )
      .orderBy(asc(schema.connections.createdAt));
    const out: AppTool[] = [];
    for (const row of rows) {
      // Named over the whole list, so turning one tool off never renames another.
      const names = exposedNames(
        row.slug,
        row.tools.map((x) => x.name),
      );
      // A tool meant for its view alone is not the bot's to call.
      const tools = row.tools.filter((x) => x.enabled && !x.appOnly);
      for (const tool of tools)
        out.push(this.appTool(row, tool, names.get(tool.name)!, t, signal, elicit, keep, showApp));
    }
    return out;
  }

  private appTool(
    row: Row,
    tool: StoredConnectionTool,
    exposed: string,
    t: T,
    signal: AbortSignal,
    elicit?: TurnElicit,
    keep?: KeepResult,
    showApp?: ShowApp,
  ): AppTool {
    const kind = tool.kind ?? tool.hinted;
    const about = [tool.title, tool.description].filter(Boolean).join(' — ');
    return {
      name: exposed,
      server: row.slug,
      description: truncate(`[${row.name}] ${about}`, 4000),
      input: {},
      // `$schema` names a draft; some model APIs refuse it inside a tool's parameters.
      jsonSchema: Object.fromEntries(Object.entries(tool.inputSchema).filter(([k]) => k !== '$schema')),
      readOnly: kind === 'read',
      // Only the app's own word makes it a read until the person says so.
      ...(kind === 'read' && tool.kind !== 'read' && { readOnlyClaimed: true }),
      internal: false,
      handler: async (args) => {
        // Read again: the connection may have changed or gone since the turn began.
        const [current] = await this.ctx.db
          .select()
          .from(schema.connections)
          .where(eq(schema.connections.id, row.id));
        if (!current || current.status !== 'connected') {
          return t('connection.unavailable', { name: row.name });
        }
        try {
          const result = await callTool(
            this.target(current),
            tool.name,
            args,
            signal,
            elicit && ((form) => elicit(form, row.name)),
          );
          if (tool.ui && current.showApps && showApp && !result.isError) {
            // The tool's own view joins the conversation; the bot's answer does not wait on it.
            void this.appResource(current, tool.ui)
              .then((page) =>
                page
                  ? showApp({
                      connectionId: row.id,
                      connection: row.name,
                      tool: tool.name,
                      page,
                      input: args,
                      result,
                    })
                  : undefined,
              )
              .catch((err) => console.warn('mcp app view', err));
          }
          return await toResult(result, t, keep && ((text) => keep(`${row.slug}-${tool.name}`, text)));
        } catch (err) {
          const e = err instanceof ConnectionClientError ? err : classify(err);
          if (e.code === 'unauthorized') {
            // A server that lists its tools to anyone but wants a sign-in for calls becomes a sign-in
            // connection, so the person gets a Sign in button rather than an unexplained sign-out.
            if (current.auth === 'none') {
              await this.ctx.db
                .update(schema.connections)
                .set({ auth: 'oauth' })
                .where(eq(schema.connections.id, row.id));
            }
            await this.setStatus(row.id, 'signed-out', this.signOutReason(current, e));
            this.changed();
            return t('connection.signedOutCall', { name: row.name });
          }
          return t('connection.callFailed', { name: row.name, message: await this.failureText(row, e) });
        }
      },
    };
  }
}

/**
 * An app's answer as plain text, for comparing one check with the next: the text parts, or the
 * structured answer when there is no text. Pictures and other media are left out.
 */
export function resultText(result: CallToolResult): string {
  const parts = (result.content ?? []).flatMap((c) =>
    c.type === 'text'
      ? [c.text]
      : c.type === 'resource' && 'text' in c.resource
        ? [String(c.resource.text)]
        : [],
  );
  if (parts.length) return parts.join('\n');
  return result.structuredContent ? JSON.stringify(result.structuredContent) : '';
}

/** A tool's view and the call it shows, for the conversation. */
export interface AppView {
  connectionId: string;
  connection: string;
  tool: string;
  page: AppResource;
  input: Record<string, unknown>;
  result: CallToolResult;
}
export type ShowApp = (view: AppView) => Promise<void>;

/** Puts a connection's question to the person in the chat of the turn that made the call. */
export type TurnElicit = (form: ElicitForm, connection: string) => Promise<ElicitResult>;

/** Writes a long answer to a file and gives back its path. */
export type KeepResult = (name: string, text: string) => Promise<string>;

/**
 * A tool's answer as text (and pictures) for the model. An answer longer than the model should
 * read at once is kept whole in a file when `keep` is given, and its start comes with the path.
 */
export async function toResult(
  result: {
    content?: unknown[];
    structuredContent?: unknown;
    isError?: boolean;
  },
  t: T,
  keep?: (text: string) => Promise<string>,
): Promise<ToolResult> {
  const texts: string[] = [];
  const images: ToolImage[] = [];
  for (const raw of result.content ?? []) {
    const c = raw as { type?: string; text?: string; data?: string; mimeType?: string; resource?: unknown };
    if (c.type === 'text' && typeof c.text === 'string') texts.push(c.text);
    else if (c.type === 'image' && c.data && c.mimeType) images.push({ data: c.data, mimeType: c.mimeType });
    else if (c.type === 'resource' || c.type === 'resource_link') texts.push(JSON.stringify(c.resource ?? c));
  }
  if (!texts.length && result.structuredContent !== undefined)
    texts.push(JSON.stringify(result.structuredContent));
  let text = texts.join('\n\n');
  if (text.length > MAX_RESULT) {
    const path = keep ? await keep(text).catch(() => null) : null;
    text = path
      ? `${text.slice(0, PREVIEW)}\n${t('connection.resultKept', { path, size: String(text.length) })}`
      : `${text.slice(0, MAX_RESULT)}\n${t('connection.resultCut')}`;
  }
  if (result.isError) text = t('connection.toolError', { message: text || '-' });
  if (!text && !images.length) text = t('connection.emptyResult');
  return images.length ? { text, images: images.slice(0, 4) } : text;
}
