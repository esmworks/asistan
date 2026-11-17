import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Agent, type AgentMessage, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Model, ModelAuth } from '@earendil-works/pi-ai';
import { completeSimple, getModel, streamSimple } from '@earendil-works/pi-ai/compat';
import { clampThinkingLevel } from '@earendil-works/pi-ai/models';
import type { Locale } from '@yumakbot/shared';
import { z } from 'zod';
import { translator, type T } from '../i18n';
import { fileTools, PathError, type FileTool } from './pi-files';
import {
  providerTrouble,
  withContext,
  resultImages,
  resultText,
  toolPermName,
  type AppTool,
  type Engine,
  type ModelTest,
  type ToolResult,
  type TurnOutcome,
  type TurnRequest,
} from './types';

export interface PiEngineOptions {
  /** Where conversation histories are kept, one JSON file per session. */
  sessionsDir: string;
  /** Stored API key for a provider; never read from the environment. */
  apiKey(provider: string): Promise<string | null>;
  /**
   * What requests to a provider carry, when it is more than a key: a sign-in with the person's
   * plan gives a token and, for Copilot, the address of that plan. Preferred over `apiKey`.
   */
  auth?(provider: string): Promise<ModelAuth | null>;
  /** Tests swap these for an offline provider. */
  resolveModel?: (provider: string, id: string) => Model<string> | undefined;
  /** A model on one of the person's own endpoints, which no built-in list holds. */
  customModel?: (provider: string, id: string) => Promise<Model<string> | undefined>;
  /** Whether a model on one of the person's endpoints takes tools; false runs it without any. */
  takesTools?: (provider: string, id: string) => Promise<boolean>;
  streamFn?: StreamFn;
  complete?: typeof completeSimple;
}

const SESSION_ID = /^[0-9a-f-]{36}$/;
/** Model calls per user turn, as for Claude bots; stops a looping bot from spending the key. */
export const MAX_STEPS = 50;
/** Messages sent to the model; older ones stay on disk but are left out of the request. */
export const MAX_CONTEXT_MESSAGES = 160;
/** A key test that takes longer than this counts as failed. */
const TEST_TIMEOUT = 30_000;

/** Keeps the latest messages, starting at a user message so no tool result loses its call. */
export function trimHistory(messages: AgentMessage[], max = MAX_CONTEXT_MESSAGES): AgentMessage[] {
  const system = messages.filter((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');
  if (rest.length <= max) return messages;
  let start = rest.length - max;
  while (start < rest.length && rest[start]!.role !== 'user') start++;
  // One long exchange with no user message inside the window: keep it whole.
  if (start >= rest.length) start = rest.findLastIndex((m) => m.role === 'user');
  return [...system, ...rest.slice(Math.max(start, 0))];
}

/** Pictures sent with a request; older screenshots are replaced by a note. */
export const MAX_CONTEXT_IMAGES = 3;

/**
 * Keeps only the latest `max` pictures in tool results; earlier ones become `note`. A bot that
 * takes a screenshot at every step would otherwise send every one of them with each request, past
 * what providers accept, though only the latest show the page as it is. The saved session keeps
 * them all.
 */
export function dropOldImages(
  messages: AgentMessage[],
  note: string,
  max = MAX_CONTEXT_IMAGES,
): AgentMessage[] {
  let kept = 0;
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!;
    if (m.role !== 'toolResult' || !m.content.some((c) => c.type === 'image')) continue;
    const content = [...m.content].reverse().map((c) => {
      if (c.type !== 'image') return c;
      return kept++ < max ? c : { type: 'text' as const, text: note };
    });
    out[i] = { ...m, content: content.reverse() };
  }
  return out;
}

export function splitModel(model: string): { provider: string; id: string } | null {
  const i = model.indexOf('/');
  if (i <= 0 || i === model.length - 1) return null;
  return { provider: model.slice(0, i), id: model.slice(i + 1) };
}

function jsonSchema(shape: z.ZodRawShape) {
  const { $schema: _drop, ...schema } = z.toJSONSchema(z.object(shape)) as Record<string, unknown>;
  return schema;
}

/**
 * The agent keeps the system prompt as the first history entry. It is rebuilt on every turn
 * (memory and time change), so stored histories never include it.
 */
function withoutSystem(messages: AgentMessage[]) {
  return messages.filter((m) => m.role !== 'system');
}

/** The most tools one request may list; OpenAI and many compatible providers refuse more. */
export const MAX_TOOLS = 128;
/** The tools that reach connected apps' tools left out of a full list. */
const FIND_TOOL = 'find_tool';
const USE_TOOL = 'use_tool';

/** The left-out tools that best match a search, with what each takes; at most ten. */
export function findTools(
  tools: AppTool[],
  query: string,
  nameOf: (t: AppTool) => string,
  none: string,
): string {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const scored = tools
    .map((tool) => {
      const params = Object.keys(
        (tool.jsonSchema?.properties as Record<string, unknown> | undefined) ?? tool.input,
      );
      const name = nameOf(tool).toLowerCase();
      const text = `${tool.description} ${params.join(' ')}`.toLowerCase();
      const score = words.reduce((n, w) => n + (name.includes(w) ? 3 : 0) + (text.includes(w) ? 1 : 0), 0);
      return { tool, score, params };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  if (!scored.length) return none;
  return scored
    .map(({ tool, params }) => {
      const schema = tool.jsonSchema ? JSON.stringify(tool.jsonSchema).slice(0, 1500) : params.join(', ');
      return `- ${nameOf(tool)}: ${tool.description.slice(0, 300)}\n  arguments: ${schema}`;
    })
    .join('\n');
}

/** How many times one turn tells the model to do what it announced. */
const MAX_NUDGES = 2;
const GO_ON =
  'You said what you would do next but made no tool call. Do it now with your tools, or say why you cannot.';

/**
 * A reply that only announces the next step and stops: short, no question, and ending on a colon,
 * a dash or an ellipsis, or opening with "Let me", "I'll", "Şimdi bakıyorum" and the like.
 */
export function announcesAction(text: string): boolean {
  const reply = text.trim();
  if (!reply || reply.length > 400 || /[?\uff1f]/.test(reply)) return false;
  return (
    /(?:[:\uff1a\u2014\u2013]|\.\.\.|\u2026)$/.test(reply) ||
    /^(?:checking|let me|i'll|i will|i'm going to|i am going to|opening|looking|searching|reading|fetching|now (?:i'll|let me))\b/i.test(
      reply,
    ) ||
    /^(?:şimdi|hemen|önce)\s+(?:\S+\s+)?\S+(?:yorum|acağım|eceğim|ayım|eyim)\b/i.test(reply)
  );
}

function textOf(m: AssistantMessage) {
  return m.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('');
}

const fail = (
  kind: 'interrupted' | 'engine',
  message: string,
  text: string,
  sessionId: string | null,
  costUsd?: number,
): TurnOutcome => ({ ok: false, kind, message, text, sessionId, costUsd: costUsd || null });

export { providerTrouble };

/** API-key models through pi-agent-core. No shell: file tools are limited to the bot's folders. */
export class PiEngine implements Engine {
  readonly kind = 'pi';
  constructor(private opts: PiEngineOptions) {}

  private sessionFile(id: string) {
    return join(this.opts.sessionsDir, `${id}.json`);
  }

  private async load(id: string): Promise<AgentMessage[]> {
    try {
      const data = JSON.parse(await readFile(this.sessionFile(id), 'utf8')) as { messages?: AgentMessage[] };
      return Array.isArray(data.messages) ? withoutSystem(data.messages) : [];
    } catch {
      return [];
    }
  }

  private async save(id: string, messages: AgentMessage[]) {
    await mkdir(this.opts.sessionsDir, { recursive: true, mode: 0o700 });
    const file = this.sessionFile(id);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: 1, messages: withoutSystem(messages) }), { mode: 0o600 });
    await rename(tmp, file);
  }

  /** The key for a provider's requests, and the model with the address and headers its sign-in gives. */
  private async authorize(
    provider: string,
    model: Model<string>,
  ): Promise<{ apiKey: string; model: Model<string> } | null> {
    const auth: ModelAuth | null = this.opts.auth
      ? await this.opts.auth(provider)
      : await this.opts.apiKey(provider).then((k) => (k ? { apiKey: k } : null));
    if (!auth?.apiKey) return null;
    return {
      apiKey: auth.apiKey,
      model: {
        ...model,
        ...(auth.baseUrl && { baseUrl: auth.baseUrl }),
        // A null header value means "leave it out".
        ...(auth.headers && {
          headers: Object.fromEntries(
            Object.entries({ ...model.headers, ...auth.headers }).filter(
              (e): e is [string, string] => typeof e[1] === 'string',
            ),
          ),
        }),
      },
    };
  }

  private async resolve(provider: string, id: string): Promise<Model<string> | undefined> {
    const resolveModel =
      this.opts.resolveModel ??
      ((p: string, m: string) => (getModel as (p: string, m: string) => Model<string> | undefined)(p, m));
    return resolveModel(provider, id) ?? (await this.opts.customModel?.(provider, id));
  }

  async testModel(ref: string, locale: Locale): Promise<ModelTest> {
    const t = translator(locale);
    const target = splitModel(ref);
    const found = target && (await this.resolve(target.provider, target.id));
    if (!target || !found) return { ok: false, detail: t('engine.modelNotFound', { model: ref }) };
    const authorized = await this.authorize(target.provider, found);
    if (!authorized) return { ok: false, detail: t('engine.noApiKey', { provider: target.provider }) };
    const { apiKey, model } = authorized;
    try {
      const reply = await (this.opts.complete ?? completeSimple)(
        model,
        { messages: [{ role: 'user', content: 'Reply with OK.', timestamp: Date.now() }] },
        // A session of its own: some providers (OpenCode) turn away a request that names none.
        { apiKey, maxTokens: 64, signal: AbortSignal.timeout(TEST_TIMEOUT), sessionId: randomUUID() },
      );
      if (reply.stopReason === 'error' || reply.stopReason === 'aborted') {
        return { ok: false, detail: reply.errorMessage || t('engine.testFailed') };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: (e as Error).message || t('engine.testFailed') };
    }
  }

  async run(req: TurnRequest): Promise<TurnOutcome> {
    const t = translator(req.locale);
    const target = splitModel(req.model);
    if (!target) return fail('engine', t('engine.modelFormat', { model: req.model }), '', req.sessionId);
    const found = await this.resolve(target.provider, target.id);
    if (!found) return fail('engine', t('engine.modelNotFound', { model: req.model }), '', req.sessionId);
    const authorized = await this.authorize(target.provider, found);
    if (!authorized) {
      return fail('engine', t('engine.noApiKey', { provider: target.provider }), '', req.sessionId);
    }
    const { apiKey, model } = authorized;

    const resumed = req.sessionId && SESSION_ID.test(req.sessionId) ? req.sessionId : null;
    const sessionId = resumed ?? randomUUID();
    const history = resumed ? await this.load(resumed) : [];
    if (!resumed) req.onSession(sessionId);

    // A local model built without tool use refuses any request that lists tools: it only talks.
    const toolless = (await this.opts.takesTools?.(target.provider, target.id)) === false;
    const files = toolless
      ? []
      : fileTools(req.sandbox, t, { seesImages: model.input.includes('image') }).filter(
          (f) => req.pickTool?.(f.permissionName) ?? true,
        );
    const byName = new Map<string, { perm: string; file?: FileTool; app?: AppTool }>();
    const tools: AgentTool[] = [];
    for (const f of files) {
      byName.set(f.name, { perm: f.permissionName, file: f });
      tools.push(this.agentTool(t, f.name, f.description, f.input, (args, signal) => f.run(args, signal)));
    }
    // Providers refuse a request listing more than MAX_TOOLS tools. The bot's own tools go first;
    // connected apps follow whole, smallest first, so a small app is never cut for a big one. What
    // does not fit stays in reach through find_tool and use_tool.
    const offered = toolless ? [] : req.tools;
    const own = offered.filter((x) => !x.server);
    const apps = new Map<string, AppTool[]>();
    for (const x of offered.filter((x) => x.server)) apps.set(x.server!, [...(apps.get(x.server!) ?? []), x]);
    const room = Math.max(0, MAX_TOOLS - files.length);
    const listed = [...own];
    const left: AppTool[] = [];
    const total = own.length + [...apps.values()].reduce((n, l) => n + l.length, 0);
    // With some left out, two places go to the tools that reach them.
    const space = total > room ? room - 2 : room;
    for (const list of [...apps.values()].sort((a, b) => a.length - b.length)) {
      if (listed.length + list.length <= space) listed.push(...list);
      else left.push(...list);
    }
    if (left.length)
      console.warn(`pi: ${left.length} tools over the ${MAX_TOOLS}-tool limit reached by search`);
    const nameOf = (tool: AppTool) => (tool.server ? `${tool.server}__${tool.name}` : tool.name);
    for (const tool of listed) {
      // A connection's tools go under its name, so two connections' tools of one name stay apart.
      const name = nameOf(tool);
      byName.set(name, { perm: toolPermName(tool), app: tool });
      tools.push(
        this.agentTool(t, name, tool.description, tool.input, (args) => tool.handler(args), tool.jsonSchema),
      );
    }
    const unlisted = new Map(left.map((x) => [nameOf(x), x]));
    if (left.length) {
      byName.set(FIND_TOOL, { perm: FIND_TOOL });
      tools.push(
        this.agentTool(t, FIND_TOOL, t('engine.findTool'), { query: z.string().min(1).max(200) }, async (a) =>
          findTools(left, String(a.query), nameOf, t('engine.findToolNone')),
        ),
      );
      byName.set(USE_TOOL, { perm: USE_TOOL });
      tools.push(
        this.agentTool(
          t,
          USE_TOOL,
          t('engine.useTool'),
          { name: z.string().min(1).max(200), arguments: z.record(z.string(), z.unknown()).default({}) },
          async (a) => {
            const tool = unlisted.get(String(a.name));
            if (!tool) return t('engine.unknownTool', { name: String(a.name) });
            return tool.handler((a.arguments ?? {}) as Record<string, unknown>);
          },
        ),
      );
    }

    const agent = new Agent({
      initialState: {
        systemPrompt: left.length
          ? `${req.systemPrompt}\n\n${t('engine.toolsSearch', { count: left.length, apps: [...new Set(left.map((x) => x.server))].join(', ') })}`
          : req.systemPrompt,
        model,
        tools,
        messages: history,
        // A model that reasons thinks as hard as the bot asks; others ignore it.
        ...(req.effort && model.reasoning && { thinkingLevel: clampThinkingLevel(model, req.effort) }),
      },
      streamFn: this.opts.streamFn ?? (streamSimple as unknown as StreamFn),
      getApiKey: (provider) => (provider === target.provider ? apiKey : undefined),
      sessionId,
      toolExecution: 'sequential',
      transformContext: async (messages) => dropOldImages(trimHistory(messages), t('engine.imageDropped')),
      beforeToolCall: async ({ toolCall, args }) => {
        // Looking tools up only reads the list.
        if (toolCall.name === FIND_TOOL) return undefined;
        // A tool reached through use_tool asks as that tool, with its own arguments: same card, rules.
        const via =
          toolCall.name === USE_TOOL
            ? (args as { name?: unknown; arguments?: unknown } | undefined)
            : undefined;
        const reached = via ? unlisted.get(String(via.name)) : undefined;
        if (via && !reached)
          return { block: true, reason: t('engine.unknownTool', { name: String(via.name) }) };
        const entry = reached ? { perm: toolPermName(reached) } : byName.get(toolCall.name);
        if (!entry) return { block: true, reason: t('engine.unknownTool', { name: toolCall.name }) };
        const input = ((reached ? via!.arguments : args) ?? {}) as Record<string, unknown>;
        let cardInput = input;
        if (entry.file) {
          try {
            cardInput = entry.file.cardInput(input, entry.file.target(input));
          } catch (err) {
            return { block: true, reason: (err as Error).message };
          }
        }
        if (req.signal.aborted) return { block: true, reason: t('engine.stopped') };
        const answer = await req.canUseTool({ toolName: entry.perm, input: cardInput });
        return answer.behavior === 'allow' ? undefined : { block: true, reason: answer.message };
      },
    });

    let costUsd = 0;
    let steps = 0;
    let capped = false;
    agent.subscribe((event) => {
      if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
        req.onActivity?.({
          id: event.toolCallId,
          // Named as permission rules and Claude bots name it (`Read`, `mcp__notion__search`).
          name: byName.get(event.toolName)?.perm ?? event.toolName,
          running: event.type === 'tool_execution_start',
        });
      } else req.onActivity?.();
      if (event.type === 'turn_end' && ++steps >= MAX_STEPS && !capped) {
        capped = true;
        agent.abort();
      } else if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        req.onText(event.assistantMessageEvent.delta);
      } else if (event.type === 'message_end' && event.message.role === 'assistant') {
        const message = event.message as AssistantMessage;
        costUsd += message.usage?.cost?.total ?? 0;
        // Taken only when tools follow, so the agent reads it before its next step.
        if (req.steering && message.content.some((c) => c.type === 'toolCall')) {
          for (const text of req.steering())
            agent.steer({ role: 'user', content: text, timestamp: Date.now() });
        }
      }
    });
    const onAbort = () => agent.abort();
    req.signal.addEventListener('abort', onAbort, { once: true });

    let thrown: string | null = null;
    try {
      await agent.prompt(withContext(req));
      await agent.waitForIdle();
      // A model that says what it is about to do ("Let me check the file:") and stops there, with no
      // call, is told to go on; a few times at most.
      for (let n = 0; n < MAX_NUDGES && tools.length && !capped && !req.signal.aborted; n++) {
        const said = [...agent.state.messages]
          .reverse()
          .find((m): m is AssistantMessage => m.role === 'assistant');
        if (said?.stopReason !== 'stop' || !announcesAction(textOf(said))) break;
        await agent.prompt(GO_ON);
        await agent.waitForIdle();
      }
    } catch (err) {
      thrown = (err as Error).message;
    } finally {
      req.signal.removeEventListener('abort', onAbort);
    }

    const messages = agent.state.messages;
    const last = [...messages].reverse().find((m): m is AssistantMessage => m.role === 'assistant');
    const text = last ? textOf(last) : '';
    if (capped) {
      return {
        ok: false,
        kind: 'engine',
        message: t('engine.stepLimit', { max: MAX_STEPS }),
        text,
        sessionId,
        costUsd: costUsd || null,
        stepLimit: true,
      };
    }
    if (req.signal.aborted || last?.stopReason === 'aborted') {
      return fail('interrupted', t('engine.stopped'), text, sessionId, costUsd);
    }
    const error =
      thrown ?? (last?.stopReason === 'error' ? (last.errorMessage ?? t('engine.modelError')) : null);
    if (error || !last) {
      // The history keeps only complete exchanges; a broken one would poison the next turn.
      if (!resumed) await this.save(sessionId, history);
      if (!error) return fail('engine', t('engine.noResponse'), text, sessionId, costUsd);
      const why = providerTrouble(error, target.provider, t);
      return {
        ok: false,
        kind: why.kind,
        message: why.message,
        text,
        sessionId,
        ...(why.kind === 'limit' && { provider: target.provider }),
        ...(why.transient && { transient: true }),
        ...(why.cut && { cut: true }),
        costUsd: costUsd || null,
      };
    }
    await this.save(sessionId, messages);
    return { ok: true, text, sessionId, costUsd: costUsd || null };
  }

  private agentTool(
    t: T,
    name: string,
    description: string,
    input: z.ZodRawShape,
    run: (args: Record<string, unknown>, signal: AbortSignal) => Promise<ToolResult>,
    /** JSON Schema another server gave; its input is checked there, not here. */
    raw?: Record<string, unknown>,
  ): AgentTool {
    const schema = raw ? z.record(z.string(), z.unknown()) : z.object(input);
    return {
      name,
      label: name,
      description,
      parameters: raw ? { type: 'object', ...raw } : jsonSchema(input),
      execute: async (_id, params, signal) => {
        const parsed = schema.safeParse(params ?? {});
        if (!parsed.success) {
          return {
            content: [{ type: 'text', text: t('tool.invalidInput', { issues: parsed.error.message }) }],
            details: undefined,
            isError: true,
          };
        }
        try {
          const r = await run(parsed.data, signal ?? new AbortController().signal);
          return {
            content: [
              { type: 'text', text: resultText(r) },
              ...resultImages(r).map((i) => ({ type: 'image' as const, data: i.data, mimeType: i.mimeType })),
            ],
            details: undefined,
          };
        } catch (err) {
          const message =
            err instanceof PathError ? err.message : t('tool.error', { message: (err as Error).message });
          return { content: [{ type: 'text', text: message }], details: undefined, isError: true };
        }
      },
    };
  }
}
