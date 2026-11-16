import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  ElicitRequestSchema,
  McpError,
  type CallToolResult,
  type ElicitResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { ElicitForm } from './elicit';
import { MAX_CONNECTION_TOOLS } from '@yumakbot/shared';
import type { StoredConnectionTool } from '../db/schema';

/**
 * This server as an MCP client of a connection's server: one client per connection, made on first
 * use (two asking at once share it) and closed after IDLE_MS unused or when the connection changes.
 * Calls and sign-ins run one at a time per connection, so two turns can't both refresh a token
 * that may be used only once.
 */

/** An OAuth app registered with a service beforehand, which this server signs in as. */
export interface OwnClient {
  client_id: string;
  client_secret?: string;
}

/** What a connection keeps sealed. */
export interface ConnectionSecrets {
  token?: string;
  ownClient?: OwnClient;
  /** What the person called `ownClient`, so accounts can pick it by name. */
  ownClientName?: string;
  oauth?: {
    client?: OAuthClientInformationMixed;
    tokens?: OAuthTokens;
    discovery?: unknown;
    /** The redirect address the sign-in used; a refresh must name the same one. */
    redirectUrl?: string;
  };
}

/** Reads and saves one connection's secrets (sealed by the caller). */
export interface SecretStore {
  get(): ConnectionSecrets;
  save(secrets: ConnectionSecrets): Promise<void>;
  /**
   * Reads the secrets again from where they are kept. Called when the connection's turn comes,
   * since a call that waited may hold a refresh token another call has already used up.
   */
  reload?(): Promise<void>;
}

/** What the client needs of a connection. */
export interface ClientTarget {
  id: string;
  url: string;
  auth: 'oauth' | 'token' | 'none';
  /** Changes whenever the address, the sign-in kind or the secrets change. */
  version: string;
  store: SecretStore;
  /** Scopes to ask for at sign-in, when not all the service lists. */
  scope?: string;
}

/**
 * `forbidden` is a 403: the sign-in holds but the service will not serve this account or app, so
 * signing in again alone seldom helps.
 */
export type ClientErrorCode = 'unauthorized' | 'forbidden' | 'unreachable' | 'notMcp' | 'timeout' | 'tool';

export class ConnectionClientError extends Error {
  constructor(
    readonly code: ClientErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const CALL_TIMEOUT_MS = 60_000;
/**
 * How long a tool call may run: a report or an export can take minutes. Set from the server's
 * configuration at start (YUMAKBOT_MCP_TIMEOUT_SECONDS); listing tools keeps the short limit.
 */
let toolCallMs = 5 * 60_000;
export function setToolCallTimeout(ms: number) {
  toolCallMs = ms;
}
/** A call that may ask the person something waits this long at most. */
export const ELICIT_TIMEOUT_MS = 15 * 60_000;
const CONNECT_TIMEOUT_MS = 20_000;
const IDLE_MS = 5 * 60_000;
const GOOGLE_ACCOUNTS = 'https://accounts.google.com';

export function clientMetadata(redirectUrl: string): OAuthClientMetadata {
  return {
    client_name: 'Yumak Bot',
    redirect_uris: [redirectUrl],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

/**
 * The server's side of an OAuth sign-in, with PKCE. It signs in as the app the person registered
 * with the service when there is one, else registers itself (dynamic client registration). A
 * registration names one redirect address; when the server is reached at another one it registers
 * again.
 */
export class ConnectionOAuthProvider implements OAuthClientProvider {
  authorizationUrl: URL | null = null;
  private stateValue: string | null = null;

  constructor(
    private readonly store: SecretStore,
    private readonly redirect: string,
    private verifier: string | null = null,
    /** Used for calls, where nobody is there to sign in: a needed sign-in is an error. */
    private readonly background = false,
  ) {}

  private get secrets() {
    return this.store.get();
  }

  private async patch(oauth: NonNullable<ConnectionSecrets['oauth']>) {
    const s = this.secrets;
    await this.store.save({ ...s, oauth: { ...s.oauth, ...oauth, redirectUrl: this.redirect } });
  }

  get redirectUrl() {
    return this.redirect;
  }

  get clientMetadata() {
    return clientMetadata(this.redirect);
  }

  state() {
    this.stateValue ??= randomBytes(24).toString('base64url');
    return this.stateValue;
  }

  get startedState() {
    return this.stateValue;
  }

  get codeVerifierValue() {
    return this.verifier;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const own = this.secrets.ownClient;
    if (own) return { ...own };
    const saved = this.secrets.oauth?.client;
    if (!saved) return undefined;
    const uris = (saved as { redirect_uris?: string[] }).redirect_uris;
    return !uris || uris.includes(this.redirect) ? saved : undefined;
  }

  async saveClientInformation(client: OAuthClientInformationMixed) {
    // The person's own app stays where they put it.
    if (this.secrets.ownClient) return;
    await this.patch({ client });
  }

  tokens() {
    return this.secrets.oauth?.tokens;
  }

  async saveTokens(tokens: OAuthTokens) {
    // A refresh may leave out the refresh token; the one we have stays good.
    const refresh = tokens.refresh_token ?? this.secrets.oauth?.tokens?.refresh_token;
    await this.patch({ tokens: { ...tokens, ...(refresh ? { refresh_token: refresh } : {}) } });
  }

  redirectToAuthorization(url: URL) {
    if (this.background) {
      // The SDK starts a new sign-in when a refresh fails for any reason. A refused refresh token
      // is dropped before that (invalid_grant), so one still kept means the refresh failed on the
      // way (network, a 5xx): the sign-in holds and the next call tries again.
      if (this.secrets.oauth?.tokens?.refresh_token) {
        throw new ConnectionClientError('unreachable', 'The service could not renew the sign-in just now');
      }
      throw new ConnectionClientError('unauthorized', 'The service asks to sign in again');
    }
    // Google gives a refresh token only when asked for one, with a fresh consent.
    if (url.origin === GOOGLE_ACCOUNTS) {
      url.searchParams.set('access_type', 'offline');
      url.searchParams.set('prompt', 'consent');
    }
    this.authorizationUrl = url;
  }

  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }

  codeVerifier() {
    if (!this.verifier) throw new ConnectionClientError('unauthorized', 'No sign-in is under way');
    return this.verifier;
  }

  async saveDiscoveryState(discovery: unknown) {
    await this.patch({ discovery });
  }

  discoveryState() {
    return this.secrets.oauth?.discovery as never;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    const oauth = { ...this.secrets.oauth };
    if (scope === 'all' || scope === 'client') delete oauth.client;
    if (scope === 'all' || scope === 'tokens') delete oauth.tokens;
    if (scope === 'all' || scope === 'discovery') delete oauth.discovery;
    if (scope === 'all' || scope === 'verifier') this.verifier = null;
    await this.store.save({ ...this.secrets, oauth });
  }
}

/** Begins an OAuth sign-in: where to send the person, or null when already signed in. */
export async function startOAuth(target: ClientTarget, redirectUrl: string) {
  const provider = new ConnectionOAuthProvider(target.store, redirectUrl);
  const result = await inLane(target, () =>
    auth(provider, { serverUrl: target.url, ...(target.scope ? { scope: target.scope } : {}) }),
  ).catch((err: unknown) => {
    throw classify(err);
  });
  if (result === 'AUTHORIZED') {
    // A kept refresh token was used and may now be spent; the open client still holds it.
    dropClient(target.id);
    return null;
  }
  if (!provider.authorizationUrl || !provider.startedState || !provider.codeVerifierValue) {
    throw new ConnectionClientError('unauthorized', 'The service did not start a sign-in');
  }
  return {
    url: provider.authorizationUrl.href,
    state: provider.startedState,
    verifier: provider.codeVerifierValue,
  };
}

/** Finishes an OAuth sign-in with the code the service sent back. */
export async function finishOAuth(target: ClientTarget, redirectUrl: string, verifier: string, code: string) {
  const provider = new ConnectionOAuthProvider(target.store, redirectUrl, verifier);
  const result = await inLane(target, () =>
    auth(provider, { serverUrl: target.url, authorizationCode: code }),
  ).catch((err: unknown) => {
    throw classify(err);
  });
  if (result !== 'AUTHORIZED')
    throw new ConnectionClientError('unauthorized', 'The sign-in was not accepted');
  dropClient(target.id);
}

/**
 * What went wrong, in words a person can act on. A refused request is said as its HTTP status and
 * the start of the service's answer, instead of the whole answer with no status.
 */
function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown })?.code;
  const refused = /^Streamable HTTP error: Error POSTing to endpoint: ([\s\S]*)$/.exec(message);
  if (refused && typeof code === 'number' && code >= 100) {
    let answer = refused[1]!.trim();
    // Some services refuse with an ordinary JSON-RPC answer as the body, which says nothing of why.
    if (isRpcAnswer(answer)) answer = '';
    return `HTTP ${code}${answer ? `: ${answer.length > 300 ? `${answer.slice(0, 300)}…` : answer}` : ''}`;
  }
  return message;
}

function isRpcAnswer(text: string): boolean {
  try {
    const body = JSON.parse(text) as { jsonrpc?: unknown; result?: unknown };
    return body.jsonrpc === '2.0' && body.result !== undefined;
  } catch {
    return false;
  }
}

/** Maps what the SDK or the network threw to a ConnectionClientError. */
export function classify(error: unknown): ConnectionClientError {
  if (error instanceof ConnectionClientError) return error;
  const name = (error as { name?: string })?.name ?? '';
  const message = messageOf(error);
  const code = (error as { code?: number | string })?.code;
  if (error instanceof McpError) {
    // -32001 is the SDK's request timeout.
    if (code === -32001) return new ConnectionClientError('timeout', message);
    return new ConnectionClientError('tool', message);
  }
  // The transport's HTTP errors carry the status as their code.
  if (code === 401) return new ConnectionClientError('unauthorized', message);
  if (code === 403) return new ConnectionClientError('forbidden', message);
  if (code === 404 || code === 405) return new ConnectionClientError('notMcp', message);
  if (name === 'UnauthorizedError' || /unauthori[sz]ed|\b401\b|invalid_token|invalid_grant/i.test(message)) {
    return new ConnectionClientError('unauthorized', message);
  }
  if (name === 'TimeoutError' || name === 'AbortError' || /timed? ?out|timeout/i.test(message)) {
    return new ConnectionClientError('timeout', message);
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|certificate|socket/i.test(message)) {
    return new ConnectionClientError('unreachable', message);
  }
  return new ConnectionClientError('notMcp', message);
}

// ---------------------------------------------------------------------------------------- pool

interface Entry {
  client: Promise<Client>;
  usedAt: number;
  version: string;
}
const entries = new Map<string, Entry>();
const queues = new Map<string, Promise<unknown>>();
let sweeper: NodeJS.Timeout | undefined;

/** Runs `fn` after whatever runs on the same connection. */
function serialized<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const before = queues.get(id) ?? Promise.resolve();
  const next = before.catch(() => undefined).then(fn);
  queues.set(id, next);
  void next
    .finally(() => {
      if (queues.get(id) === next) queues.delete(id);
    })
    .catch(() => undefined);
  return next;
}

/** Runs `fn` on the connection's turn, with its secrets as they are by then. */
function inLane<T>(target: ClientTarget, fn: () => Promise<T>): Promise<T> {
  return serialized(target.id, async () => {
    await target.store.reload?.();
    return fn();
  });
}

/**
 * Fetch for a connection's transport that never opens the standalone GET stream. Only calls and
 * tool lists are used, while that stream would sign in again on its own, outside the connection's
 * turn, and two refreshes at once spend a refresh token that may be used only once. A server
 * answers 405 when it has no such stream, which the SDK takes as such.
 */
function withoutGetStream(endpoint: URL): typeof fetch {
  return (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (
      method.toUpperCase() === 'GET' &&
      new URL(url).href === endpoint.href &&
      !new Headers(init?.headers).has('last-event-id')
    ) {
      return Promise.resolve(new Response(null, { status: 405 }));
    }
    return fetch(input, init);
  };
}

function providerOf(target: ClientTarget) {
  if (target.auth === 'token') {
    const token = target.store.get().token;
    return { headers: token ? { Authorization: `Bearer ${token}` } : undefined, authProvider: undefined };
  }
  if (target.auth === 'oauth') {
    const redirect = target.store.get().oauth?.redirectUrl;
    // Never signed in: requests go without a token, and the server answers 401.
    if (!redirect) return { headers: undefined, authProvider: undefined };
    return {
      headers: undefined,
      authProvider: new ConnectionOAuthProvider(target.store, redirect, null, true),
    };
  }
  return { headers: undefined, authProvider: undefined };
}

/** Answers a server's question in the middle of a tool call; set only while such a call runs. */
export type Elicit = (form: ElicitForm) => Promise<ElicitResult>;
/**
 * Who answers for each connection right now. Calls to one connection run one at a time (its
 * lane), so a question that arrives belongs to the call under way.
 */
const askers = new Map<string, Elicit>();

async function connect(target: ClientTarget): Promise<Client> {
  // Forms only: a server asking to open a web page is declined.
  const client = new Client(
    { name: 'YumakBot', version: '0.2.1' },
    {
      capabilities: {
        elicitation: { form: {} },
        // MCP apps: the conversation can show a tool's own view.
        extensions: { [UI_EXTENSION]: { mimeTypes: [APP_MIME] } },
      },
    },
  );
  client.setRequestHandler(ElicitRequestSchema, async (req) => {
    const ask = askers.get(target.id);
    const params = req.params as Partial<ElicitForm> & { mode?: string };
    if (!ask || params.mode === 'url' || !params.requestedSchema?.properties) return { action: 'decline' };
    return ask({ message: params.message ?? '', requestedSchema: params.requestedSchema });
  });
  const { headers, authProvider } = providerOf(target);
  const endpoint = new URL(target.url);
  const transport = new StreamableHTTPClientTransport(endpoint, {
    fetch: withoutGetStream(endpoint),
    ...(authProvider ? { authProvider } : {}),
    ...(headers ? { requestInit: { headers } } : {}),
  });
  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
  } catch (error) {
    await client.close().catch(() => undefined);
    const failure = classify(error);
    throw failure.code === 'tool' ? new ConnectionClientError('notMcp', failure.message) : failure;
  }
  return client;
}

function sweepIdle() {
  const now = Date.now();
  for (const [id, entry] of entries) if (now - entry.usedAt > IDLE_MS) dropClient(id);
  if (!entries.size && sweeper) {
    clearInterval(sweeper);
    sweeper = undefined;
  }
}

function clientFor(target: ClientTarget): Promise<Client> {
  const entry = entries.get(target.id);
  if (entry && entry.version === target.version) {
    entry.usedAt = Date.now();
    return entry.client;
  }
  if (entry) dropClient(target.id);
  const client = connect(target);
  entries.set(target.id, { client, usedAt: Date.now(), version: target.version });
  client.catch(() => {
    if (entries.get(target.id)?.client === client) entries.delete(target.id);
  });
  sweeper ??= setInterval(sweepIdle, 60_000);
  sweeper.unref?.();
  return client;
}

/** Closes a connection's client (it changed, was signed out of or removed). */
export function dropClient(id: string) {
  const entry = entries.get(id);
  if (!entry) return;
  entries.delete(id);
  void entry.client.then((c) => c.close()).catch(() => undefined);
}

/** Closes every client (server shutdown, tests). */
export function dropAllClients() {
  for (const id of [...entries.keys()]) dropClient(id);
}

async function withClient<T>(target: ClientTarget, fn: (client: Client) => Promise<T>): Promise<T> {
  return inLane(target, async () => {
    try {
      return await fn(await clientFor(target));
    } catch (error) {
      const failure = classify(error);
      if (failure.code !== 'tool') dropClient(target.id);
      throw failure;
    }
  });
}

// --------------------------------------------------------------------------------------- tools

export const hintedKind = (tool: Pick<Tool, 'annotations'>): 'read' | 'write' =>
  tool.annotations?.readOnlyHint === true ? 'read' : 'write';

/** Lists the server's tools, keeping the person's choices for tools it still has. */
export const UI_EXTENSION = 'io.modelcontextprotocol/ui';
export const APP_MIME = 'text/html;profile=mcp-app';

const record = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** A tool's view: `_meta.ui.resourceUri`, or the older flat `ui/resourceUri`; only a ui:// one. */
export function toolUi(tool: { _meta?: unknown }): string | null {
  const meta = record(tool._meta);
  const ui = record(meta?.ui);
  const uri = typeof ui?.resourceUri === 'string' ? ui.resourceUri : meta?.['ui/resourceUri'];
  return typeof uri === 'string' && uri.startsWith('ui://') ? uri : null;
}

/** A tool its server meant for the view alone: `_meta.ui.visibility` without "model". */
export function appOnlyTool(tool: { _meta?: unknown }): boolean {
  const seen = record(record(tool._meta)?.ui)?.visibility;
  return Array.isArray(seen) && !seen.includes('model');
}

/** A view's page and what it may load, as its server describes it. */
export interface AppResource {
  html: string;
  connect: string[];
  resources: string[];
}

/** Reads a tool's view; null when it is not an HTML app page or is too large. */
export async function readAppResource(target: ClientTarget, uri: string): Promise<AppResource | null> {
  return withClient(target, async (client) => {
    const r = await client.readResource({ uri }, { timeout: CALL_TIMEOUT_MS });
    const page = r.contents.find((c) => c.uri === uri) ?? r.contents[0];
    if (!page || typeof (page as { text?: unknown }).text !== 'string') return null;
    if (!String(page.mimeType ?? '').startsWith('text/html')) return null;
    const html = (page as { text: string }).text;
    if (html.length > 1_000_000) return null;
    const csp = record(record(record(page._meta)?.ui)?.csp);
    const list = (v: unknown) =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    return { html, connect: list(csp?.connectDomains), resources: list(csp?.resourceDomains) };
  });
}

export async function listTools(
  target: ClientTarget,
  kept: StoredConnectionTool[] = [],
): Promise<StoredConnectionTool[]> {
  const before = new Map(kept.map((t) => [t.name, t]));
  return withClient(target, async (client) => {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: CALL_TIMEOUT_MS });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor && tools.length < MAX_CONNECTION_TOOLS);
    return tools.slice(0, MAX_CONNECTION_TOOLS).map((tool) => {
      const old = before.get(tool.name);
      return {
        name: tool.name,
        title: tool.title ?? tool.annotations?.title ?? null,
        description: (tool.description ?? '').slice(0, 4000),
        inputSchema: (tool.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
        hinted: hintedKind(tool),
        ui: toolUi(tool),
        appOnly: appOnlyTool(tool),
        kind: old?.kind ?? null,
        enabled: old?.enabled ?? true,
      };
    });
  });
}

/** Calls a tool. Throws a ConnectionClientError when the server can't be used; a tool's own error comes back in the result. */
export async function callTool(
  target: ClientTarget,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  elicit?: Elicit,
): Promise<CallToolResult> {
  return withClient(target, async (client) => {
    if (elicit) askers.set(target.id, elicit);
    try {
      return (await client.callTool({ name, arguments: args }, undefined, {
        // A question to the person may take a while; the call waits for the answer.
        timeout: elicit ? ELICIT_TIMEOUT_MS : toolCallMs,
        maxTotalTimeout: elicit ? ELICIT_TIMEOUT_MS : toolCallMs,
        ...(signal ? { signal } : {}),
      })) as CallToolResult;
    } finally {
      if (askers.get(target.id) === elicit) askers.delete(target.id);
    }
  });
}
