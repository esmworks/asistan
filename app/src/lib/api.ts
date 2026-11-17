import type {
  TelegramStatus,
  WhatsAppSet,
  WhatsAppStatus,
  ApnsSet,
  RoutineGateMode,
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
  MemoryChange,
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
  ProviderSignIn,
  PageShare,
  ApiCredential,
  ApiCredentialCreate,
  ApiCredentialUpdate,
  EmailSettings,
  AiEndpoint,
  AiEndpoints,
  AiEndpointSet,
  AiKind,
  PluginInstall,
  PluginInstallResult,
  PluginPlan,
} from '@yumakbot/shared';
import { getT, useLocale } from '@/i18n';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  extra: Record<string, string> = {},
): Promise<T> {
  const hasBody = method !== 'GET' && method !== 'DELETE';
  // The server writes its error messages in the language the page asks in.
  const headers: Record<string, string> = { ...extra, 'accept-language': useLocale.getState().locale };
  // A file goes as it is; everything else as JSON.
  const raw = body instanceof Blob;
  if (hasBody) headers['content-type'] = raw ? 'application/octet-stream' : 'application/json';
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers,
    body: hasBody ? (raw ? body : JSON.stringify(body ?? {})) : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/access' && path !== '/api/login') onUnauthorized();
    const message =
      (data as { error?: string } | null)?.error ?? getT()('error.requestFailed', { status: res.status });
    throw new ApiError(res.status, message);
  }
  return data as T;
}

export const http = {
  get: <T>(p: string) => request<T>('GET', p),
  post: <T>(p: string, b?: unknown) => request<T>('POST', p, b),
  patch: <T>(p: string, b?: unknown) => request<T>('PATCH', p, b),
  put: <T>(p: string, b?: unknown) => request<T>('PUT', p, b),
  del: <T>(p: string) => request<T>('DELETE', p),
};

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
  /** The routine pre-check; missing on older servers. */
  routineGate?: RoutineGateMode;
  /** The bots' browsers go out through the person's own computer; missing on older servers. */
  browserViaComputer?: boolean;
  /** The domain bots receive mail at; empty when mail is off. Missing on older servers. */
  emailDomain?: string;
  /** Unset until a language is chosen; the app then stores the one it opened in. */
  language?: Locale;
}

/** Typed endpoints. Paths mirror the server routes. */
export const api = {
  /** `account` is missing on servers older than username and password sign-in. */
  session: () => http.get<{ authenticated: boolean; account?: boolean }>('/api/session'),
  /** Signs this browser in with a one-time pairing code from a signed-in device. */
  pair: (code: string) => http.post<{ ok: true }>('/api/pair', { code }),
  /** A one-time code that signs one more device in within five minutes. */
  pairingCode: () => http.post<{ code: string; expiresAt: string; url: string | null }>('/api/pairing'),
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
  /** A bot's own Telegram bot: never the token, which is write-only. */
  telegram: (botId: string) => http.get<TelegramStatus>(`/api/bots/${botId}/telegram`),
  connectTelegram: (botId: string, token: string) =>
    http.put<TelegramStatus>(`/api/bots/${botId}/telegram`, { token }),
  pairTelegram: (botId: string) => http.post<TelegramStatus>(`/api/bots/${botId}/telegram/pair`, {}),
  updateTelegram: (botId: string, patch: { notices: boolean }) =>
    http.patch<TelegramStatus>(`/api/bots/${botId}/telegram`, patch),
  disconnectTelegram: (botId: string) => http.del<{ ok: true }>(`/api/bots/${botId}/telegram`),
  whatsapp: () => http.get<WhatsAppStatus>('/api/whatsapp'),
  setWhatsapp: (b: WhatsAppSet) => http.put<WhatsAppStatus>('/api/whatsapp', b),
  linkWhatsapp: () => http.post<WhatsAppStatus>('/api/whatsapp/link', {}),
  disconnectWhatsapp: () => http.del<WhatsAppStatus>('/api/whatsapp'),
  settings: () => http.get<Settings>('/api/settings'),
  updateSettings: (p: Partial<Settings>) => http.patch<Settings>('/api/settings', p),
  providers: () => http.get<ProviderInfo[]>('/api/providers'),
  providerModels: (id: string) => http.get<string[]>(`/api/providers/${encodeURIComponent(id)}/models`),
  setProviderKey: (id: string, key: string) =>
    http.put<{ ok: true }>(`/api/providers/${encodeURIComponent(id)}/key`, { key }),
  testProviderModel: (id: string, model: string) =>
    http.post<{ ok: true } | { ok: false; detail: string }>(`/api/providers/${encodeURIComponent(id)}/test`, {
      model,
    }),
  removeProviderKey: (id: string) => http.del<{ ok: true }>(`/api/providers/${encodeURIComponent(id)}/key`),
  /** Starts signing in to a provider with the person's plan; follow it with `signIn`. */
  startSignIn: (provider: string, enterprise?: string) =>
    http.post<ProviderSignIn>(`/api/providers/${encodeURIComponent(provider)}/sign-in`, { enterprise }),
  signIn: (id: string) => http.get<ProviderSignIn>(`/api/sign-ins/${id}`),
  pasteSignIn: (id: string, input: string) =>
    http.post<ProviderSignIn>(`/api/sign-ins/${id}/paste`, { input }),
  cancelSignIn: (id: string) => http.del<{ ok: true }>(`/api/sign-ins/${id}`),
  signOut: (provider: string) =>
    http.del<{ ok: true }>(`/api/providers/${encodeURIComponent(provider)}/sign-in`),
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
  uploadFile: (threadId: string, file: File) =>
    http.post<{ name: string; size: number }>(
      `/api/threads/${threadId}/files?name=${encodeURIComponent(file.name)}`,
      file,
    ),
  /** `keepalive`: sent while the page closes, so the request outlives it. */
  removeFile: (threadId: string, name: string, opts: { keepalive?: boolean } = {}) => {
    const path = `/api/threads/${threadId}/files/${encodeURIComponent(name)}`;
    if (!opts.keepalive) return http.del<{ ok: true }>(path);
    return fetch(path, { method: 'DELETE', credentials: 'same-origin', keepalive: true }).then(() => ({
      ok: true as const,
    }));
  },
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
  updateConnection: (id: string, c: ConnectionUpdate) => http.patch<Connection>(`/api/connections/${id}`, c),
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
  addRule: (r: { list: 'ask' | 'allow' | 'block'; pattern: string }) =>
    http.post<PermissionRule>('/api/rules', r),
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
  /** Memory changes bots asked for while nobody watched; they wait for the person. */
  memoryChanges: () => http.get<MemoryChange[]>('/api/memory-changes'),
  acceptMemoryChange: (id: string) => http.post<{ ok: true }>(`/api/memory-changes/${id}/accept`, {}),
  rejectMemoryChange: (id: string) => http.del<{ ok: true }>(`/api/memory-changes/${id}`),

  routines: () => http.get<Routine[]>('/api/routines'),
  createRoutine: (r: unknown) => http.post<Routine>('/api/routines', r),
  updateRoutine: (id: string, p: unknown) => http.patch<Routine>(`/api/routines/${id}`, p),
  removeRoutine: (id: string) => http.del<{ ok: true }>(`/api/routines/${id}`),
  runRoutine: (id: string) => http.post<RoutineRun | null>(`/api/routines/${id}/run`),
  routineFailureSeen: (id: string) => http.post<{ ok: true }>(`/api/routines/${id}/failure-seen`),
  routineRuns: (id: string) => http.get<RoutineRun[]>(`/api/routines/${id}/runs`),

  library: (botId: string) => http.get<LibraryFile[]>(`/api/bots/${botId}/library`),
  /** `inline`: an image to show on the page rather than a download. */
  fileUrl: (botId: string, path: string, opts: { inline?: boolean } = {}) =>
    `/api/bots/${botId}/library/file?path=${encodeURIComponent(path)}${opts.inline ? '&inline=1' : ''}`,
  /** A page the bot made, served to run in the app's sandboxed frame. */
  pageUrl: (botId: string, path: string, height?: number) =>
    `/api/bots/${botId}/library/page?path=${encodeURIComponent(path)}${height ? `&h=${height}` : ''}`,
  previewPlugin: (url: string) => http.post<PluginPlan>('/api/plugins/preview', { url }),
  installPlugin: (input: PluginInstall) => http.post<PluginInstallResult>('/api/plugins/install', input),
  aiEndpoints: () =>
    http.get<AiEndpoints & { memoryIndex: { indexed: number; total: number } }>('/api/ai-endpoints'),
  setAiEndpoint: (kind: AiKind, input: AiEndpointSet) =>
    http.put<AiEndpoint>(`/api/ai-endpoints/${kind}`, input),
  clearAiEndpoint: (kind: AiKind) => http.del<AiEndpoint>(`/api/ai-endpoints/${kind}`),
  testAiEndpoint: (kind: AiKind) =>
    http.post<{ ok: boolean; detail: string }>(`/api/ai-endpoints/${kind}/test`),
  /** Whether replies can be read aloud by the server's speech service. */
  speechStatus: () => http.get<{ available: boolean }>('/api/speech'),
  /** A reply read aloud, as audio; null when the server could not. */
  speech: async (text: string): Promise<Blob> => {
    const res = await fetch('/api/speech', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'accept-language': useLocale.getState().locale },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(data?.error ?? String(res.status));
    }
    return res.blob();
  },
  emailSettings: () => http.get<EmailSettings>('/api/email'),
  renewEmailSecret: () => http.post<EmailSettings>('/api/email/secret'),
  claimEmail: (botId: string, name: string) => http.post<EmailSettings>(`/api/bots/${botId}/email`, { name }),
  releaseEmail: (botId: string) => http.del<EmailSettings>(`/api/bots/${botId}/email`),
  apiKeys: () => http.get<ApiCredential[]>('/api/api-keys'),
  addApiKey: (input: ApiCredentialCreate) => http.post<ApiCredential>('/api/api-keys', input),
  updateApiKey: (id: string, input: ApiCredentialUpdate) =>
    http.patch<ApiCredential>(`/api/api-keys/${id}`, input),
  removeApiKey: (id: string) => http.del<{ ok: true }>(`/api/api-keys/${id}`),
  /** The page opened on its own, with the print dialog, to save it as a PDF. */
  pagePrintUrl: (botId: string, path: string) =>
    `/api/bots/${botId}/library/page?path=${encodeURIComponent(path)}&print=1`,
  pageShare: (botId: string, path: string) =>
    http.get<{ share: PageShare | null }>(
      `/api/bots/${botId}/library/share?path=${encodeURIComponent(path)}`,
    ),
  sharePage: (botId: string, path: string, name: string) =>
    http.post<PageShare>(`/api/bots/${botId}/library/share`, { path, name }),
  pageShares: () => http.get<PageShare[]>('/api/page-shares'),
  unsharePage: (token: string) => http.del<{ ok: true }>(`/api/page-shares/${encodeURIComponent(token)}`),
  /** Several files of a bot's folders as one ZIP download. */
  zipUrl: (botId: string, paths: string[], name?: string) =>
    `/api/bots/${botId}/library/zip?${paths.map((p) => `path=${encodeURIComponent(p)}`).join('&')}${name ? `&name=${encodeURIComponent(name)}` : ''}`,
  /** What a bot import file would make; saves nothing. */
  previewBotImport: (file: File) => http.post<BotImportPlan>('/api/import/bots?preview=1', file),
  steerMessage: (id: string) => http.post<Message>(`/api/messages/${id}/steer`),
  importBots: (file: File) => http.post<BotImportResult>('/api/import/bots', file),
  /** Whether the server can turn speech into text (an OpenAI or Groq key is saved). */
  transcribeStatus: () => http.get<{ available: boolean }>('/api/transcribe'),
  /** A recording from the message box, written out by the provider whose key the server has. */
  transcribe: async (audio: Blob, lang: string) => {
    const res = await fetch(`/api/transcribe?lang=${encodeURIComponent(lang)}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': audio.type || 'audio/webm', 'accept-language': useLocale.getState().locale },
      body: audio,
    });
    const data = (await res.json().catch(() => null)) as { text?: string; error?: string } | null;
    if (!res.ok)
      throw new ApiError(res.status, data?.error ?? getT()('error.requestFailed', { status: res.status }));
    return { text: data?.text ?? '' };
  },
  /** Writes a sealed backup of everything on the server, ready for one download at `/api/backup/<id>`. */
  createBackup: (password: string) => http.post<{ id: string; size: number }>('/api/backup', { password }),
  /** Replaces everything with a backup; the server starts again after. The body is the file itself. */
  restoreBackup: (file: File, password: string) =>
    request<{ tables: number; files: number }>('POST', '/api/backup/restore', file, {
      'x-backup-password': encodeURIComponent(password),
    }),
};
