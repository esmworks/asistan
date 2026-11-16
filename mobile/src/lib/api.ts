import type {
  ApnsSet,
  ApnsStatus,
  PushDeviceSet,
  SkillWarning,
  Room,
  RoomCreate,
  RoomUpdate,
  BotImportPlan,
  BotImportResult,
  Approval,
  Bot,
  BotSummary,
  SessionInfo,
  AccountSet,
  TodayReport,
  Group,
  Memory,
  Message,
  PermissionRule,
  ProviderInfo,
  CustomEndpointCreate,
  CustomEndpointUpdate,
  Routine,
  Skill,
  SkillCreate,
  SkillUpdate,
  RoutineRun,
  SearchHit,
  ServerInfo,
  Thread,
  Locale,
  VaultLogin,
  VaultLoginCreate,
  VaultLoginUpdate,
  BotMove,
  GroupMove,
  ProfileFocus,
  ProfileHelp,
  ClaudeAuthSet,
  ClaudeAuthStatus,
  ClaudeModel,
  Effort,
  Connection,
  ConnectionAuthStart,
  ConnectionBots,
  ConnectionCreate,
  ConnectionToolPatch,
  ConnectionUpdate,
  UsageRange,
  UsageReport,
} from '@yumakbot/shared';
import { locale, t } from '@/i18n';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** How long a request may wait for the server before it counts as unreachable. */
const TIMEOUT_MS = 15_000;

/** `fetch` that gives up after `ms`, so an address that never answers does not hang the screen. */
async function fetchWithin(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One request to the server at `origin`. The sign-in cookie lives in the phone's own cookie store,
 * which keeps it across launches, so no token is handled here.
 */
async function request<T>(origin: string, method: string, path: string, body?: unknown): Promise<T> {
  const hasBody = method !== 'GET' && method !== 'DELETE';
  // The server writes its error messages in the language the app asks in.
  const headers: Record<string, string> = { 'accept-language': locale, accept: 'application/json' };
  // A file goes as it is; everything else as JSON.
  const raw = body instanceof Blob;
  if (hasBody) headers['content-type'] = raw ? 'application/octet-stream' : 'application/json';
  // The server takes a signed-in write only from a page of its own origin; a browser says so in
  // this header, and the app, which has no page, says it for itself.
  if (method !== 'GET') headers.origin = origin;
  const res = await fetchWithin(
    `${origin}${path}`,
    {
      method,
      credentials: 'include',
      headers,
      body: hasBody ? (raw ? (body as Blob) : JSON.stringify(body ?? {})) : undefined,
    },
    // A large file may take a while to go up over a home network.
    raw ? 10 * 60_000 : TIMEOUT_MS,
  );
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const message =
      (data as { error?: string } | null)?.error ?? t('error.requestFailed', { status: res.status });
    throw new ApiError(res.status, message);
  }
  return data as T;
}

/** Whether an YumakBot server answers at the origin. */
export async function answers(origin: string): Promise<boolean> {
  try {
    const res = await fetchWithin(`${origin}/api/health`, {}, 6000);
    const data = (await res.json()) as { ok?: unknown } | null;
    return res.status === 200 && data?.ok === true;
  } catch {
    return false;
  }
}

/** A file picked on the phone, by where it lies on the device. */
export interface PickedFile {
  uri: string;
  name: string;
}

async function blobOf(file: PickedFile): Promise<Blob> {
  return (await fetch(file.uri)).blob();
}

export interface LibraryFile {
  path: string;
  name: string;
  size: number;
  modifiedAt: string;
}
export interface JobView {
  job: {
    id: string;
    status: string;
    fromBotId: string;
    toBotId: string;
    /** The other bot's conversation the exchange happens in. */
    toThreadId: string;
    request: string;
    reply: string | null;
  };
  messages: Message[];
}
export interface Settings {
  userName: string;
  /** Profile fields and `onboarded` are missing on servers older than the first-run questions. */
  addressAs?: string;
  occupation?: string;
  focus?: ProfileFocus;
  helpWith?: ProfileHelp[];
  aboutMe?: string;
  onboarded?: boolean;
  /** Claude defaults; missing on older servers. Empty leaves it to the server or the model. */
  defaultModel?: string;
  effort?: Effort | '';
  defaultEngine?: 'claude' | 'pi';
  /** `provider/model` new bots on another provider start with. */
  piModel?: string;
  /** `provider/model` that carries a turn once the usage limit is spent; empty waits instead. */
  backupModel?: string;
  timezone: string;
  /** The most the bots may spend in a calendar month, in US dollars; 0 for none. Missing on older servers. */
  monthlyLimitUsd?: number;
  /** Unset until a language is chosen; the app then stores the one it opened in. */
  language?: Locale;
}

/** Typed endpoints of the server at `origin`; paths mirror the server routes. */
export function apiFor(origin: string) {
  const http = {
    get: <T>(p: string) => request<T>(origin, 'GET', p),
    post: <T>(p: string, b?: unknown) => request<T>(origin, 'POST', p, b),
    patch: <T>(p: string, b?: unknown) => request<T>(origin, 'PATCH', p, b),
    put: <T>(p: string, b?: unknown) => request<T>(origin, 'PUT', p, b),
    del: <T>(p: string) => request<T>(origin, 'DELETE', p),
  };
  return {
    /** `account` is missing on servers older than username and password sign-in. */
    session: () => http.get<{ authenticated: boolean; account?: boolean }>('/api/session'),
    access: (key: string) => http.post<{ ok: true }>('/api/access', { key }),
    login: (username: string, password: string) =>
      http.post<{ ok: true }>('/api/login', { username, password }),
    account: () => http.get<{ username: string | null }>('/api/account'),
    setAccount: (input: AccountSet) => http.put<{ username: string }>('/api/account', input),
    logout: () => http.post<{ ok: true }>('/api/logout'),
    sessions: () => http.get<SessionInfo[]>('/api/sessions'),
    /** Signs out one device, or with `others` every device but this one. */
    endSession: (id: string | 'others') =>
      http.del<{ ended: number }>(`/api/sessions/${encodeURIComponent(id)}`),
    info: () => http.get<ServerInfo>('/api/info'),
    checkClaude: () => http.post<ServerInfo['claude']>('/api/info/claude-check'),
    claudeAuth: () => http.get<ClaudeAuthStatus>('/api/claude/auth'),
    /** Saves a token or key, then tries it with one real request. */
    setClaudeAuth: (b: ClaudeAuthSet) => http.put<ServerInfo['claude']>('/api/claude/auth', b),
    clearClaudeAuth: () => http.del<ServerInfo['claude']>('/api/claude/auth'),
    claudeModels: () => http.get<ClaudeModel[]>('/api/claude/models'),
    /** This phone's push token and choices; the server sends notices that pass them. */
    pushDevice: (b: PushDeviceSet) => http.put<{ ok: true }>('/api/push/device', b),
    pushTest: (token: string) => http.post<{ ok: true }>('/api/push/test', { token }),
    /** The Apple key for iPhone notifications; write-only, reads say only which key it is. */
    apns: () => http.get<ApnsStatus>('/api/push/apns'),
    setApns: (b: ApnsSet) => http.put<ApnsStatus>('/api/push/apns', b),
    clearApns: () => http.del<ApnsStatus>('/api/push/apns'),
    settings: () => http.get<Settings>('/api/settings'),
    updateSettings: (p: Partial<Settings>) => http.patch<Settings>('/api/settings', p),
    providers: () => http.get<ProviderInfo[]>('/api/providers'),
    providerModels: (id: string) => http.get<string[]>(`/api/providers/${encodeURIComponent(id)}/models`),
    setProviderKey: (id: string, key: string) =>
      http.put<{ ok: true }>(`/api/providers/${encodeURIComponent(id)}/key`, { key }),
    testProviderModel: (id: string, model: string) =>
      http.post<{ ok: true } | { ok: false; detail: string }>(
        `/api/providers/${encodeURIComponent(id)}/test`,
        {
          model,
        },
      ),
    removeProviderKey: (id: string) => http.del<{ ok: true }>(`/api/providers/${encodeURIComponent(id)}/key`),
    addEndpoint: (input: CustomEndpointCreate) => http.post<ProviderInfo>('/api/providers/custom', input),
    discoverEndpoints: () =>
      http.get<{ name: string; baseUrl: string; models: string[] }[]>('/api/providers/discover'),
    updateEndpoint: (id: string, patch: CustomEndpointUpdate) =>
      http.patch<ProviderInfo>(`/api/providers/${encodeURIComponent(id)}`, patch),
    refreshEndpoint: (id: string) =>
      http.post<string[]>(`/api/providers/${encodeURIComponent(id)}/refresh`, {}),
    removeEndpoint: (id: string) => http.del<{ ok: true }>(`/api/providers/${encodeURIComponent(id)}`),

    bots: () => http.get<Bot[]>('/api/bots'),
    bot: (id: string) => http.get<Bot>(`/api/bots/${id}`),
    createBot: (b: unknown) => http.post<Bot>('/api/bots', b),
    updateBot: (id: string, b: unknown) => http.patch<Bot>(`/api/bots/${id}`, b),
    archiveBot: (id: string) => http.post<Bot>(`/api/bots/${id}/archive`),
    today: () => http.get<TodayReport>('/api/today'),
    /** Pins a message above its conversation; null takes the pin away. */
    pinMessage: (threadId: string, messageId: string | null) =>
      http.put<Thread>(`/api/threads/${threadId}/pin`, { messageId }),
    /** A new conversation copied from this message's up to it. */
    forkFrom: (messageId: string) => http.post<Thread>(`/api/messages/${messageId}/fork`),
    updateThread: (
      id: string,
      patch: {
        title?: string;
        archived?: boolean;
        snoozedUntil?: string | null;
        pinned?: boolean;
        icon?: string;
      },
    ) => http.patch<Thread>(`/api/threads/${id}`, patch),
    /** Sets what a conversation is for; empty clears it. */
    setGoal: (threadId: string, goal: string) => http.patch<Thread>(`/api/threads/${threadId}`, { goal }),
    /** Deletes every conversation of the bot but its main one. */
    clearThreads: (botId: string) => http.del<{ deleted: number }>(`/api/bots/${botId}/threads`),
    fetchSkill: (url: string) => http.post<{ text: string; name: string }>('/api/skills/fetch', { url }),
    setupImport: () =>
      http.get<{
        available: boolean;
        skills: { name: string; description: string; source: string; warnings: SkillWarning[] }[];
        servers: { name: string; url: string; source: string }[];
      }>('/api/setup-import'),
    runSetupImport: (body: { skills: string[]; servers: string[] }) =>
      http.post<{ skills: number; servers: number }>('/api/setup-import', body),
    restoreBot: (id: string) => http.post<Bot>(`/api/bots/${id}/restore`),
    archivedBots: () =>
      http.get<Bot[]>('/api/bots?archived=1').then((list) => list.filter((b) => b.archivedAt)),
    /** Deletes an archived bot for good, with its conversations and files. */
    deleteBot: (id: string) => http.del<{ ok: true }>(`/api/bots/${id}`),
    moveBot: (id: string, to: BotMove) => http.post<Bot>(`/api/bots/${id}/move`, to),
    summaries: () => http.get<BotSummary[]>('/api/summaries'),
    skills: () => http.get<Skill[]>('/api/skills'),
    createSkill: (input: SkillCreate) => http.post<Skill>('/api/skills', input),
    updateSkill: (id: string, patch: SkillUpdate) => http.patch<Skill>(`/api/skills/${id}`, patch),
    removeSkill: (id: string) => http.del<{ ok: true }>(`/api/skills/${id}`),
    setSkillBot: (id: string, botId: string, on: boolean) =>
      http.put<Skill>(`/api/skills/${id}/bots/${botId}`, { on }),
    enableWebhook: (id: string) => http.post<Routine>(`/api/routines/${id}/webhook`, {}),
    disableWebhook: (id: string) => http.del<Routine>(`/api/routines/${id}/webhook`),
    usage: (days: UsageRange, botId?: string) =>
      http.get<UsageReport>(`/api/usage?days=${days}${botId ? `&bot=${encodeURIComponent(botId)}` : ''}`),
    openBrowserWindow: (botId: string, url?: string) =>
      http.post<{ ok: true }>(`/api/bots/${botId}/browser/window`, { url }),
    closeBrowserWindow: (botId: string) => http.del<{ ok: true }>(`/api/bots/${botId}/browser/window`),

    groups: () => http.get<Group[]>('/api/groups'),
    createGroup: (name: string) => http.post<Group>('/api/groups', { name }),
    renameGroup: (id: string, name: string) => http.patch<Group>(`/api/groups/${id}`, { name }),
    moveGroup: (id: string, to: GroupMove) => http.post<Group>(`/api/groups/${id}/move`, to),
    deleteGroup: (id: string) => http.del<{ ok: true }>(`/api/groups/${id}`),

    threads: (botId: string) => http.get<Thread[]>(`/api/bots/${botId}/threads`),
    mainThread: (botId: string) => http.get<Thread>(`/api/bots/${botId}/main-thread`),
    newThread: (botId: string) => http.post<Thread>(`/api/bots/${botId}/threads`, {}),
    rooms: () => http.get<Room[]>('/api/rooms'),
    createRoom: (input: RoomCreate) => http.post<Room>('/api/rooms', input),
    updateRoom: (id: string, patch: RoomUpdate) => http.patch<Room>(`/api/rooms/${id}`, patch),
    deleteRoom: (id: string) => http.del<{ ok: true }>(`/api/rooms/${id}`),
    sendToRoom: (id: string, clientId: string, text: string, replyTo?: string) =>
      http.post<Message>(`/api/rooms/${id}/messages`, { clientId, text, replyTo }),
    stopRoom: (id: string) => http.post<{ stopped: boolean }>(`/api/rooms/${id}/stop`),
    thread: (id: string) => http.get<Thread>(`/api/threads/${id}`),
    deleteThread: (id: string) => http.del<{ ok: true }>(`/api/threads/${id}`),
    resetThread: (id: string) => http.post<{ ok: true }>(`/api/threads/${id}/reset`),
    messages: (threadId: string, before?: string) =>
      http.get<Message[]>(
        `/api/threads/${threadId}/messages${before ? `?before=${encodeURIComponent(before)}` : ''}`,
      ),
    send: (threadId: string, clientId: string, text: string, files: string[] = [], replyTo?: string) =>
      http.post<Message>(`/api/threads/${threadId}/messages`, { clientId, text, files, replyTo }),
    search: (q: string, opts: { threadId?: string; limit?: number } = {}) =>
      http.get<SearchHit[]>(
        `/api/search?q=${encodeURIComponent(q)}` +
          (opts.threadId ? `&threadId=${encodeURIComponent(opts.threadId)}` : '') +
          (opts.limit ? `&limit=${opts.limit}` : ''),
      ),
    editMessage: (id: string, text: string) => http.patch<Message>(`/api/messages/${id}`, { text }),
    removeMessage: (id: string) => http.del<{ ok: true }>(`/api/messages/${id}`),
    retryMessage: (id: string) => http.post<{ ok: true; turnId: string }>(`/api/messages/${id}/retry`),
    /** A tool call an MCP app's view makes, through the server to its own connection. */
    appCall: (messageId: string, name: string, args: Record<string, unknown>) =>
      http.post<unknown>(`/api/apps/${messageId}/call`, { name, arguments: args }),
    react: (messageId: string, emoji: string | null) =>
      http.put<Message>(`/api/messages/${messageId}/reaction`, { emoji }),
    /** Puts a file in the conversation's folder; the server may pick another name if it is taken. */
    uploadFile: async (threadId: string, file: PickedFile) =>
      http.post<{ name: string; size: number }>(
        `/api/threads/${threadId}/files?name=${encodeURIComponent(file.name)}`,
        await blobOf(file),
      ),
    removeFile: (threadId: string, name: string) =>
      http.del<{ ok: true }>(`/api/threads/${threadId}/files/${encodeURIComponent(name)}`),
    stop: (threadId: string) => http.post<{ stopped: boolean }>(`/api/threads/${threadId}/stop`),
    job: (id: string) => http.get<JobView>(`/api/jobs/${id}`),

    approvals: () => http.get<Approval[]>('/api/approvals'),
    answer: (
      id: string,
      d: {
        decision: 'allow' | 'deny';
        answer?: string;
        answers?: string[];
        remember?: boolean;
        login?: { username: string; password: string; save: boolean; exact?: boolean };
      },
    ) => http.post<Approval>(`/api/approvals/${id}`, d),
    connections: () => http.get<Connection[]>('/api/connections'),
    connectionRedirectUrl: () => http.get<{ url: string }>('/api/connections/redirect-url'),
    addConnection: (c: ConnectionCreate) => http.post<Connection>('/api/connections', c),
    updateConnection: (id: string, c: ConnectionUpdate) =>
      http.patch<Connection>(`/api/connections/${id}`, c),
    removeConnection: (id: string) => http.del<{ ok: true }>(`/api/connections/${id}`),
    refreshConnection: (id: string) => http.post<Connection>(`/api/connections/${id}/refresh`, {}),
    signInConnection: (id: string) => http.post<ConnectionAuthStart>(`/api/connections/${id}/signin`, {}),
    signOutConnection: (id: string) => http.post<Connection>(`/api/connections/${id}/signout`, {}),
    setConnectionTool: (id: string, name: string, patch: ConnectionToolPatch) =>
      http.patch<Connection>(`/api/connections/${id}/tools/${encodeURIComponent(name)}`, patch),
    setConnectionBots: (id: string, access: ConnectionBots) =>
      http.put<Connection>(`/api/connections/${id}/bots`, access),
    vault: () => http.get<VaultLogin[]>('/api/vault'),
    addVaultLogin: (v: VaultLoginCreate) => http.post<VaultLogin>('/api/vault', v),
    updateVaultLogin: (id: string, v: VaultLoginUpdate) => http.patch<VaultLogin>(`/api/vault/${id}`, v),
    removeVaultLogin: (id: string) => http.del<{ ok: true }>(`/api/vault/${id}`),
    rules: () => http.get<PermissionRule[]>('/api/rules'),
    addRule: (r: { list: 'ask' | 'allow'; pattern: string }) => http.post<PermissionRule>('/api/rules', r),
    removeRule: (id: string) => http.del<{ ok: true }>(`/api/rules/${id}`),

    memory: () => http.get<Memory[]>('/api/memory'),
    addMemory: (m: { scope: 'bot' | 'user'; botId?: string | null; content: string; site?: string | null }) =>
      http.post<Memory>('/api/memory', m),
    updateMemory: (id: string, p: { content: string }) => http.patch<Memory>(`/api/memory/${id}`, p),
    removeMemory: (id: string) => http.del<{ ok: true }>(`/api/memory/${id}`),
    /** Deletes every note the bot keeps for itself. */
    removeBotMemory: (botId: string) => http.del<{ count: number }>(`/api/bots/${botId}/memory`),
    staleMemory: () => http.get<Memory[]>('/api/memory-stale'),
    removeStaleMemory: (ids: string[]) => http.post<{ count: number }>('/api/memory-stale/delete', { ids }),

    routines: () => http.get<Routine[]>('/api/routines'),
    createRoutine: (r: unknown) => http.post<Routine>('/api/routines', r),
    updateRoutine: (id: string, p: unknown) => http.patch<Routine>(`/api/routines/${id}`, p),
    removeRoutine: (id: string) => http.del<{ ok: true }>(`/api/routines/${id}`),
    runRoutine: (id: string) => http.post<RoutineRun | null>(`/api/routines/${id}/run`),
    routineRuns: (id: string) => http.get<RoutineRun[]>(`/api/routines/${id}/runs`),

    library: (botId: string) => http.get<LibraryFile[]>(`/api/bots/${botId}/library`),
    /** `inline`: an image to show on the page rather than a download. */
    fileUrl: (botId: string, path: string, opts: { inline?: boolean } = {}) =>
      `${origin}/api/bots/${botId}/library/file?path=${encodeURIComponent(path)}${opts.inline ? '&inline=1' : ''}`,
    /** A page the bot made, served to run in the app's sandboxed frame. */
    pageUrl: (botId: string, path: string, height?: number) =>
      `${origin}/api/bots/${botId}/library/page?path=${encodeURIComponent(path)}${height ? `&h=${height}` : ''}`,
    /** Several files of a bot's folders as one ZIP download. */
    zipUrl: (botId: string, paths: string[], name?: string) =>
      `${origin}/api/bots/${botId}/library/zip?${paths.map((p) => `path=${encodeURIComponent(p)}`).join('&')}${name ? `&name=${encodeURIComponent(name)}` : ''}`,
    /** What a bot import file would make; saves nothing. */
    previewBotImport: async (file: PickedFile) =>
      http.post<BotImportPlan>('/api/import/bots?preview=1', await blobOf(file)),
    steerMessage: (id: string) => http.post<Message>(`/api/messages/${id}/steer`),
    importBots: async (file: PickedFile) =>
      http.post<BotImportResult>('/api/import/bots', await blobOf(file)),
  };
}
export type Api = ReturnType<typeof apiFor>;
