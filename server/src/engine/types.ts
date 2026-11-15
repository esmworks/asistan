import type { ClaudeModel, Effort, Locale } from '@yumakbot/shared';
import type { z } from 'zod';
import type { T } from '../i18n';
import { readableError } from '../util';

/** An image a tool hands back to the model, e.g. a screenshot of the bot's browser. */
export interface ToolImage {
  /** Base64, without a data: prefix. */
  data: string;
  mimeType: string;
}

/** What a tool returns: plain text, or text with images. */
export type ToolResult = string | { text: string; images: ToolImage[] };

/**
 * What a bot answers when a turn leaves it nothing to say, such as a reaction that needs no reply.
 * Such an answer is not shown and not saved.
 */
export const SILENT_REPLY = 'NO_REPLY';

/** True for an answer that is only the silent reply, give or take spaces and a full stop. */
export const isSilentReply = (text: string) => text.trim().replace(/\.$/, '') === SILENT_REPLY;

/** True while streamed text may still turn out to be the silent reply, so it is held back. */
export const maybeSilentReply = (text: string) => SILENT_REPLY.startsWith(text.trim());

export const resultText = (r: ToolResult) => (typeof r === 'string' ? r : r.text);
export const resultImages = (r: ToolResult) => (typeof r === 'string' ? [] : r.images);

/** A tool the app gives to a bot, independent of the engine that runs it. */
export interface AppTool {
  name: string;
  description: string;
  input: z.ZodRawShape;
  /** Tools that only read state may run without asking. */
  readOnly: boolean;
  /** Only touches YumakBot's own data (memory, bot messages); never asks in `ask` mode. */
  internal: boolean;
  /** Per-call override: some inputs of an internal tool still need a card. */
  gated?: (args: Record<string, unknown>) => Promise<boolean>;
  /**
   * The MCP server the tool is shown under (`mcp__<server>__<name>`): a connection's own name for
   * its tools; unset for the app's own tools (`yumakbot`).
   */
  server?: string;
  /** The input as JSON Schema, for tools another server describes; `input` is then unused. */
  jsonSchema?: Record<string, unknown>;
  handler(args: Record<string, unknown>): Promise<ToolResult>;
}

export const APP_SERVER = 'yumakbot';

/** The name permission rules and cards use for a tool. */
export const toolPermName = (t: Pick<AppTool, 'name' | 'server'>) =>
  `mcp__${t.server ?? APP_SERVER}__${t.name}`;

export interface PermissionAsk {
  toolName: string;
  input: Record<string, unknown>;
}

export type PermissionAnswer =
  { behavior: 'allow'; updatedInput?: Record<string, unknown> } | { behavior: 'deny'; message: string };

export interface Sandbox {
  cwd: string;
  /** Extra readable/writable folders (bot files, group files). */
  additionalDirectories: string[];
  /** Folders sandboxed shell commands may write. */
  writable: string[];
  /**
   * Whether the bot may reach the internet. Off, its web tools are withheld; either way a
   * sandboxed command asks (SandboxNetworkAccess) before each host, and the turn answers.
   */
  internet: boolean;
  readOnly: boolean;
}

export interface TurnRequest {
  turnId: string;
  threadId: string;
  botId: string;
  model: string;
  /** How hard the model thinks; unset leaves it to the model. API-key models use it when they reason. */
  effort?: Effort;
  prompt: string;
  /**
   * What changes on every turn, such as the time now, sent before the prompt. It stays out of the
   * system prompt, which then reads the same turn after turn and keeps the model's prompt cache.
   */
  context?: string;
  /** Engine session to resume, if the thread has one. */
  sessionId: string | null;
  /**
   * What the resumed session had cost by the end of its last run, as the engine reported it. An
   * engine whose cost figure runs on across a resumed session subtracts it to price this run alone.
   */
  sessionCostUsd?: number | null;
  systemPrompt: string;
  /** Language for messages the engine writes (errors, tool texts). */
  locale: Locale;
  sandbox: Sandbox;
  /** Where shell commands run: this server's OS sandbox, or the bot's desktop (an app tool). */
  shell: 'sandbox' | 'computer';
  tools: AppTool[];
  canUseTool(ask: PermissionAsk): Promise<PermissionAnswer>;
  onText(delta: string): void;
  /** The bot's plan for the task, each time it changes. */
  onPlan?(items: PlanItem[]): void;
  /**
   * What the person added while the turn runs, taken once: the engine calls it after each round of
   * tool calls and gives the texts to the model before its next step. A message it never takes
   * (the bot answered without another tool call) gets a turn of its own afterwards.
   */
  steering?(): string[];
  /** The account is close to its usage limit: how much is used (0–1) and when it resets. */
  onLimitNear?(info: { used: number | null; resetsAt: Date | null }): void;
  onSession(sessionId: string): void;
  /** The engine condensed the conversation into a summary of its own to make room. */
  onCompacted?(): void;
  /**
   * A sign of life, on every event the engine sees; with `tool`, a tool call started (`running`)
   * or ended. A turn silent for too long is stopped as stalled.
   */
  onActivity?(tool?: { id: string; name: string; running: boolean }): void;
  /** Aborted when the user stops the turn. */
  signal: AbortSignal;
}

/** One step of a bot's plan. */
export interface PlanItem {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** A plan as an engine's to-do tool writes it; null when it is not one. */
export function planItems(raw: unknown): PlanItem[] | null {
  const todos = (raw as { todos?: unknown } | null)?.todos;
  if (!Array.isArray(todos)) return null;
  const items: PlanItem[] = [];
  for (const t of todos.slice(0, 50)) {
    const o = (t ?? {}) as { content?: unknown; status?: unknown; activeForm?: unknown };
    const text = typeof o.content === 'string' ? o.content : '';
    if (!text.trim()) continue;
    const status =
      o.status === 'in_progress' || o.status === 'completed' ? (o.status as PlanItem['status']) : 'pending';
    items.push({ text: text.trim().slice(0, 300), status });
  }
  return items;
}

/**
 * What one run cost, from the running total the engine reported for its session and the total the
 * session had before it. A total below the earlier one means the count started over (a new session,
 * a transcript that kept no total): it is then this run's alone. A total within rounding of the
 * earlier one, as a stored copy of it reads back, is a run that spent nothing.
 */
export function runCost(total: number | null, before: number | null | undefined): number | null {
  if (total === null) return null;
  if (before == null) return total;
  if (total >= before) return total - before;
  return before - total <= before * 1e-6 ? 0 : total;
}

/** `sessionCostUsd`: the session's running total after this run, when the engine keeps one. */
export type TurnOutcome = (
  | { ok: true; text: string; sessionId: string | null; costUsd: number | null }
  | {
      ok: false;
      /**
       * `lostSession`: the session to resume no longer exists; a new one has to take over.
       * `limit`: the account's usage limit is spent until `resetsAt`.
       * `stalled`: nothing came from the engine for too long, and the turn was stopped.
       */
      kind: 'auth' | 'interrupted' | 'engine' | 'lostSession' | 'limit' | 'stalled';
      message: string;
      text: string;
      sessionId: string | null;
      /** For `limit`: when the account may be used again, if the engine said. */
      resetsAt?: Date | null;
      /** For `limit`: the provider whose limit it is, when it is not Claude's. */
      provider?: string;
      /** The model is busy or down for now; another model may do the work. */
      transient?: boolean;
      /** What the turn spent before it failed, when the engine knows: it counts toward the limit. */
      costUsd?: number | null;
      /** It ran out of steps mid-task; the session holds the work so far, and the person may go on. */
      stepLimit?: boolean;
    }
) & { sessionCostUsd?: number | null };

/** How model servers say they are overloaded or briefly down. */
/** The prompt with the turn's changing context before it. */
export const withContext = (req: Pick<TurnRequest, 'prompt' | 'context'>) =>
  req.context ? `${req.context}\n\n${req.prompt}` : req.prompt;

export const OVERLOADED = /overloaded|\b(503|529)\b|service unavailable|temporarily unavailable/i;

/**
 * A provider's error in words the person can act on: a refused key, an empty balance, a rate
 * limit, an overloaded or unreachable server. The provider's own text follows as the detail.
 */
export function providerTrouble(
  raw: string,
  provider: string,
  t: T,
): { kind: 'limit' | 'engine'; message: string; transient?: boolean } {
  const detail = readableError(raw.trim(), 300);
  const said = (key: Parameters<T>[0]) => `${t(key, { provider })} (${detail})`;
  if (/\b401\b|unauthori[sz]ed|invalid.{0,20}(api[ _-]?)?key|incorrect api key|authentication/i.test(raw)) {
    return { kind: 'engine', message: said('engine.providerKey') };
  }
  if (
    /\b402\b|insufficient (credits|balance|funds|quota)|billing|payment required|credit balance/i.test(raw)
  ) {
    return { kind: 'engine', message: said('engine.providerBilling') };
  }
  if (/\b413\b|(request|payload|entity) too large/i.test(raw)) {
    return { kind: 'engine', message: said('engine.providerTooLarge') };
  }
  if (/\b429\b|rate.?limit|too many requests|quota/i.test(raw)) {
    return { kind: 'limit', message: said('engine.providerLimit') };
  }
  if (OVERLOADED.test(raw)) return { kind: 'engine', message: said('engine.providerBusy'), transient: true };
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|network|socket hang up/i.test(raw)) {
    return { kind: 'engine', message: said('engine.providerUnreachable'), transient: true };
  }
  return { kind: 'engine', message: raw };
}

export interface AccountStatus {
  status: 'ok' | 'logged-out' | 'error';
  /** A known cause the app words itself; `detail` then holds the specifics. */
  reason?: 'api-key' | 'timeout';
  detail: string | null;
}

/** One permission request a small model looks at before a card opens (the `review` mode). */
export interface ReviewRequest {
  toolName: string;
  input: Record<string, unknown>;
  bot: { name: string; description: string };
  /** What the turn was started with: the person's message, or a routine's instructions. */
  request: string;
  /** Language of the reason the person reads. */
  locale: Locale;
  signal: AbortSignal;
}

/** `allow`: clearly safe, runs without a card. `ask`: the person decides. Never a denial. */
export interface ReviewVerdict {
  decision: 'allow' | 'ask';
  reason: string;
}

export interface Engine {
  readonly kind: string;
  run(req: TurnRequest): Promise<TurnOutcome>;
  account?(): Promise<AccountStatus>;
  /** The login check plus one real request, after the credential changed. */
  probe?(): Promise<AccountStatus>;
  models?(): Promise<ClaudeModel[]>;
  /** One short request to a `provider/model` with its stored key, before a bot uses it. */
  testModel?(model: string, locale: Locale): Promise<ModelTest>;
  /** Looks at one permission request with a small model (the `review` mode). */
  review?(req: ReviewRequest): Promise<ReviewVerdict>;
}

export type ModelTest = { ok: true } | { ok: false; detail: string };
