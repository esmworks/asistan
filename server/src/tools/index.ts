import {
  ALL_TOOLS,
  catalogEntry,
  CONNECTION_CATALOG,
  ConnectionCreate,
  describeSchedule,
  Schedule,
  parseAnswers,
  PERMISSION_MODES,
  type RoutineCheck,
  type RoutineUpdate,
  searchCatalog,
  skillSlug,
  type ApiSource,
  type Bot,
  type Memory,
  type MemoryChange,
  outsideIn,
  type OutsideTrigger,
  type Routine,
  type Skill,
} from '@yumakbot/shared';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../context';
import { schema } from '../db';
import { planItems, type AppTool, type PlanItem, type ToolResult } from '../engine/types';
import { attended, type TurnRow } from '../runtime/turns';
import { STRICTNESS } from '../services/approvals';
import type { Services } from '../services';
import { isServerKey, type T } from '../i18n';
import { errorText, newId, truncate } from '../util';
import { browserTools, type AskLogin } from './browser';
import { computerTools } from './computer';
import { pageImageTool, sendFileTool, showPageTool } from './files';
import { imageTool } from './images';
import { apiTools } from './api';
import { emailTools } from './email';
import { tableTools } from './tables';
import { ticketTools } from './tickets';
import { sourceOf } from '../services/memory';
import { redactSecrets } from '../services/secrets';
import { siteOf } from '../services/vault';
import { workspacePaths } from '../workspace';

type ThreadRow = typeof schema.threads.$inferSelect;

/**
 * An answer a question card offers. Models often send `{label, description}` instead of a plain
 * string; both are taken, so a card is never refused over the shape of its choices.
 */
const Choice = z.union([
  z.string().min(1).max(200),
  z.object({ label: z.string().min(1).max(200), description: z.string().max(500).optional() }),
]);
const choiceLabel = (c: z.infer<typeof Choice>) => (typeof c === 'string' ? c : c.label);

/** Query parameters that carry a sign-in or a signature rather than say which page it is. */
const SECRET_PARAM =
  /(?:^|[_.-])(?:token|secret|password|passwd|pwd|key|apikey|sig|signature|auth|session|sessionid|sid|credential|code)s?(?:$|[_.-])|^x-(?:amz|goog)-/i;

/**
 * The page a bot says a fact came from, as a web address the person can open; null for none and
 * undefined for something that is not one. Whatever could sign someone in is taken out first: the
 * address is kept and shown, while what it held would leak with it.
 */
export function sourceAddress(from: string): string | null | undefined {
  try {
    const url = new URL(from.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    url.username = '';
    url.password = '';
    // A fragment is where sign-in pages hand over their tokens; it never names another page.
    url.hash = '';
    for (const [name, value] of [...url.searchParams]) {
      if (SECRET_PARAM.test(name) || redactSecrets(value, '').redacted) url.searchParams.delete(name);
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

const MEMORY_TOOLS = new Set<string>(['memory_search', 'memory_write', 'memory_update', 'memory_forget']);
const MANAGER_MEMORY_TOOLS = new Set<string>(['memory_search', 'memory_update', 'memory_forget']);

/** Tool builder for one turn: descriptions and results are written in the turn's language. */
const definer =
  (t: T) =>
  <S extends z.ZodRawShape>(
    name: ToolName,
    input: S,
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>,
    access: 'read' | 'internal' | 'gated' = 'gated',
    gated?: (args: z.infer<z.ZodObject<S>>) => Promise<boolean>,
  ): AppTool => {
    const parser = z.object(input);
    return {
      name,
      description: t(`tool.${name}`),
      input,
      readOnly: access === 'read',
      internal: access !== 'gated',
      ...(gated && {
        gated: async (raw: Record<string, unknown>) => {
          const parsed = parser.safeParse(raw);
          return parsed.success ? gated(parsed.data) : false;
        },
      }),
      handler: async (raw) => {
        const parsed = parser.safeParse(raw);
        if (!parsed.success) {
          // A shared schema's own message is a key into the catalog.
          const issues = parsed.error.issues.map((i) => (isServerKey(i.message) ? t(i.message) : i.message));
          return t('tool.invalidInput', { issues: issues.join('; ') });
        }
        try {
          return await handler(parsed.data);
        } catch (err) {
          return t('tool.error', { message: errorText(err, t) });
        }
      },
    };
  };

/**
 * Exactly one emoji, including skin tones, joined sequences and flags (👍🏽, ❤️, 👨‍💻, 🇹🇷).
 * Built at runtime because the `v` flag is newer than the compile target.
 */
export const EMOJI = new RegExp('^\\p{RGI_Emoji}$', 'v');

export type Define = ReturnType<typeof definer>;

/** Conversations one turn may open with open_conversation. */
const MAX_OPENED = 5;

export type ToolName =
  | 'ask_user'
  | 'react'
  | 'send_file'
  | 'show_page'
  | 'image_create'
  | 'api_keys_list'
  | 'credential_request'
  | 'api_request'
  | 'api_operations'
  | 'api_call'
  | 'tickets_list'
  | 'ticket_read'
  | 'ticket_create'
  | 'ticket_update'
  | 'tables_list'
  | 'table_define'
  | 'table_rows'
  | 'table_add'
  | 'table_update'
  | 'table_delete_rows'
  | 'email_inbox'
  | 'email_read'
  | 'page_to_image'
  | 'browser_open'
  | 'browser_snapshot'
  | 'browser_click'
  | 'browser_hover'
  | 'browser_dialog'
  | 'browser_type'
  | 'browser_fill'
  | 'browser_code'
  | 'browser_login'
  | 'browser_upload'
  | 'browser_select'
  | 'browser_press'
  | 'browser_scroll'
  | 'browser_history'
  | 'browser_tabs'
  | 'browser_screenshot'
  | 'browser_wait'
  | 'memory_search'
  | 'conversations_search'
  | 'message_read'
  | 'skill_read'
  | 'my_activity'
  | 'skill_save'
  | 'routine_create'
  | 'routine_update'
  | 'routine_delete'
  | 'routine_failed'
  | 'routine_stop'
  | 'app_suggest'
  | 'quick_replies'
  | 'app_add'
  | 'plan_update'
  | 'memory_write'
  | 'memory_update'
  | 'memory_forget'
  | 'bots_list'
  | 'open_conversation'
  | 'bot_send'
  | 'bot_status'
  | 'bot_stop'
  | 'bot_conversations_read'
  | 'bot_create'
  | 'models_list'
  | 'bot_update'
  | 'bot_profile'
  | 'bot_skill'
  | 'bot_archive'
  | 'computer_screenshot'
  | 'computer_click'
  | 'computer_type'
  | 'computer_key'
  | 'computer_scroll'
  | 'computer_drag'
  | 'run_command'
  | 'command_status';

/**
 * Puts questions to the person on a card in the turn's conversation and waits for the answers,
 * one per question. Used by ask_user and by a connection that asks something during a call.
 */
export async function askPerson(
  s: Services,
  o: {
    bot: Bot;
    thread: { id: string };
    turn: { id: string };
    signal: AbortSignal;
    timeoutMs?: number;
    title?: string;
    items: { question: string; context?: string; options: string[]; secret?: boolean }[];
  },
) {
  const summary = o.title ?? o.items[0]!.question;
  const r = await s.approvals.ask({
    threadId: o.thread.id,
    botId: o.bot.id,
    turnId: o.turn.id,
    kind: 'question',
    toolName: 'ask_user',
    input: { ...(o.title ? { title: o.title } : {}), questions: o.items },
    summary,
    options: o.items.length === 1 ? o.items[0]!.options : [],
    signal: o.signal,
    timeoutMs: o.timeoutMs,
    onCreated: async (a) => {
      await s.threads.addMessage({
        threadId: o.thread.id,
        role: 'approval',
        author: `bot:${o.bot.id}`,
        text: summary,
        props: { approvalId: a.id },
        turnId: o.turn.id,
      });
    },
  });
  return { ...r, answers: parseAnswers(r.answer, o.items.length) };
}

export class ToolFactory {
  constructor(
    private ctx: Ctx,
    private services: Services,
  ) {}

  forTurn(opts: {
    bot: Bot;
    thread: ThreadRow;
    turn: TurnRow;
    signal: AbortSignal;
    t: T;
    skills?: Skill[];
    /** The bot's mail address; with one, it gets its inbox. */
    email?: string | null;
    /** OpenAPI documents the bot may call operations of. */
    apiSources?: ApiSource[];
    /** Shows the bot's plan in the chat; given to engines without a to-do tool of their own. */
    plan?: (items: PlanItem[]) => Promise<void>;
    /** Whether the bot keeps any table; without one it gets only the tools to start one. */
    hasTables?: boolean;
    /** The outside text the turn has read so far, if any. */
    outside?: () => OutsideTrigger | null;
    /** Tells the turn a tool showed it outside text. */
    readOutside?: (kind: OutsideTrigger) => Promise<void>;
  }): AppTool[] {
    const { bot, thread, turn, signal, t, plan } = opts;
    const reads = () => opts.outside?.() ?? null;
    /** The outside text among messages a tool shows, if any: a mail, a webhook's post, a forward. */
    const shows = async (props: Record<string, unknown>[]) => {
      const kind = props.map(outsideIn).find(Boolean);
      if (kind) await opts.readOutside?.(kind);
    };
    const skills = opts.skills ?? [];
    const def = definer(t);
    // Conversations this turn opened; a few at most, so a looping bot cannot fill the list.
    let opened = 0;
    const s = this.services;
    // Only the person's own message or emoji has them there; a room member another bot named is not.
    const fromUser = attended(turn.source);
    // Nobody may be watching a routine's or another bot's turn: its cards close unanswered in time.
    const unattended = fromUser ? undefined : this.ctx.config.unattendedApprovalMs;
    /**
     * Why nobody watches this turn, for a memory change it asks for: such a change waits for the
     * person, since a webhook's payload, a page or another bot's message may be behind it.
     */
    let away: Promise<MemoryChange['origin']> | null = null;
    const awayFrom = () =>
      (away ??= (async (): Promise<MemoryChange['origin']> => {
        // The person was there, but the run had read someone else's words.
        if (fromUser) return { kind: 'outside', name: bot.name };
        if (turn.source === 'routine' && turn.routineRunId) {
          const [r] = await this.ctx.db
            .select({ name: schema.routines.name })
            .from(schema.routineRuns)
            .innerJoin(schema.routines, eq(schema.routines.id, schema.routineRuns.routineId))
            .where(eq(schema.routineRuns.id, turn.routineRunId))
            .limit(1);
          return { kind: 'routine', name: r?.name ?? '' };
        }
        if (turn.jobId) {
          const [j] = await this.ctx.db
            .select({ name: schema.bots.name })
            .from(schema.jobs)
            .innerJoin(schema.bots, eq(schema.bots.id, schema.jobs.fromBotId))
            .where(eq(schema.jobs.id, turn.jobId))
            .limit(1);
          return { kind: 'bot', name: j?.name ?? '' };
        }
        return { kind: 'bot', name: '' };
      })());
    type Change = Omit<MemoryChange, 'id' | 'createdAt' | 'proposedBy' | 'origin' | 'threadId'>;
    const propose = async (change: Change) => {
      await s.memory.propose({
        ...change,
        proposedBy: bot.id,
        origin: await awayFrom(),
        threadId: thread.id,
      });
      return t(fromUser ? 'tool.memoryProposedOutside' : 'tool.memoryProposed');
    };
    /**
     * How a memory change goes: made now, or waiting for the person. A turn nobody watches, or one
     * that read outside text, only proposes it: what it read may be behind it. The memory every
     * bot shares, and another bot's own notes, reach other bots' prompts, so a change there
     * asks the person on a card even while they are there. Null: make it now; otherwise the
     * answer to give the bot.
     */
    const memoryGate = async (change: Change): Promise<string | null> => {
      if (!fromUser || reads()) return propose(change);
      const shared = change.scope === 'user' || (!!change.botId && change.botId !== bot.id);
      if (!shared) return null;
      const summary =
        change.action === 'write'
          ? t('tool.memoryCardWrite', { bot: bot.name, content: truncate(change.content, 400) })
          : change.action === 'update'
            ? t('tool.memoryCardUpdate', {
                bot: bot.name,
                before: truncate(change.before ?? '', 300),
                content: truncate(change.content, 400),
              })
            : t('tool.memoryCardForget', { bot: bot.name, content: truncate(change.content, 400) });
      const approve = t('tool.approve');
      const r = await s.approvals.ask({
        threadId: thread.id,
        botId: bot.id,
        turnId: turn.id,
        kind: 'question',
        toolName: `memory_${change.action}`,
        input: { scope: change.scope, content: change.content },
        summary,
        options: [approve, t('tool.reject')],
        signal,
        onCreated: async (a) => {
          await s.threads.addMessage({
            threadId: thread.id,
            role: 'approval',
            author: `bot:${bot.id}`,
            text: a.summary,
            props: { approvalId: a.id },
            turnId: turn.id,
          });
        },
      });
      return r.status === 'allowed' && (!r.answer || r.answer === approve) ? null : t('tool.memoryDeclined');
    };
    /**
     * The routine a bot names, by name or id: one of its own, or, for a manager, one of another
     * bot's too, but not another manager's. A reason when there is none or more than one.
     */
    const pickRoutine = async (
      ref: string,
      botRef?: string,
    ): Promise<{ routine: Routine; routines: Routine[] } | string> => {
      let owners: Bot[];
      if (botRef) {
        const target = await s.bots.resolve(botRef, bot);
        if (target.id !== bot.id && !bot.isManager) return t('tool.routineNotYours');
        if (target.id !== bot.id && target.isManager) return t('tool.otherManager');
        owners = [target];
      } else {
        owners = bot.isManager ? (await s.bots.list()).filter((b) => b.id === bot.id || !b.isManager) : [bot];
      }
      const names = new Map(owners.map((b) => [b.id, b.name]));
      const routines = (await s.routines.list(owners.length === 1 ? owners[0]!.id : undefined)).filter((r) =>
        names.has(r.botId),
      );
      const wanted = ref.trim().toLowerCase();
      const named = routines.filter((r) => r.id === ref.trim() || r.name.toLowerCase() === wanted);
      // A routine of the bot's own wins over another bot's of the same name.
      const own = named.filter((r) => r.botId === bot.id);
      const hits = own.length ? own : named;
      const label = (r: Routine) => (r.botId === bot.id ? r.name : `${names.get(r.botId)} · ${r.name}`);
      if (hits.length === 1) return { routine: hits[0]!, routines };
      if (hits.length > 1) {
        return t('tool.routineAmbiguous', {
          name: ref,
          bots: hits.map((r) => names.get(r.botId)).join(', '),
        });
      }
      return t('tool.routineNotFound', { name: ref, names: routines.map(label).join(', ') || '-' });
    };
    /**
     * The bots whose own notes this bot may read and change, by id with their names: itself, and for
     * a manager every bot that is not a manager, archived ones too so their notes can be cleared.
     */
    const memoryOwners = async (): Promise<Map<string, string>> => {
      if (!bot.isManager) return new Map([[bot.id, bot.name]]);
      const all = await s.bots.list({ includeArchived: true });
      return new Map(all.filter((b) => b.id === bot.id || !b.isManager).map((b) => [b.id, b.name]));
    };
    const tools: AppTool[] = [
      def(
        'ask_user',
        {
          title: z.string().max(120).optional(),
          questions: z
            .array(
              z.object({
                question: z.string().min(1).max(500),
                context: z
                  .string()
                  .max(1000)
                  .optional()
                  .describe('A short line under the question: why you ask, or what the options mean'),
                options: z.array(Choice).max(8).optional(),
                secret: z.boolean().optional(),
              }),
            )
            .min(1)
            .max(6)
            .optional(),
          question: z.string().min(1).max(500).optional(),
          options: z.array(Choice).max(8).optional(),
        },
        async ({ title, questions, question, options }) => {
          const items = (questions ?? (question ? [{ question, options, secret: undefined }] : [])).map(
            (q) => ({
              question: q.question,
              ...('context' in q && q.context ? { context: q.context } : {}),
              options: (q.options ?? []).map(choiceLabel),
              ...(q.secret ? { secret: true } : {}),
            }),
          );
          if (!items.length) return t('tool.noQuestion');
          const r = await askPerson(s, { bot, thread, turn, signal, timeoutMs: unattended, title, items });
          if (r.timedOut) return t('tool.questionTimedOut');
          if (r.status === 'expired') return t('tool.questionExpired');
          if (r.status === 'denied') return t('tool.questionSkipped');
          const answers = r.answers;
          const lines = items.map((q, i) => {
            const given = answers[i] || t('tool.emptyAnswer');
            return `- ${q.question} → ${q.secret && answers[i] ? t('tool.secretAnswer', { answer: given }) : given}`;
          });
          return t('tool.answers', { lines: lines.join('\n'), id: r.approvalId });
        },
        'internal',
      ),
      ...(plan
        ? [
            def(
              'plan_update',
              {
                todos: z
                  .array(
                    z.object({
                      content: z.string().min(1).max(300),
                      status: z.enum(['pending', 'in_progress', 'completed']),
                    }),
                  )
                  .max(50),
              },
              async (a) => {
                await plan(planItems(a) ?? []);
                return t('tool.planShown');
              },
              'internal',
            ),
          ]
        : []),
      ...(skills.length
        ? [
            def(
              'skill_read',
              { name: z.string().min(1).max(100) },
              async ({ name }) => {
                const wanted = name.trim().toLowerCase();
                const skill = skills.find((k) => k.name === wanted);
                if (!skill) {
                  return t('tool.noSkill', { name, names: skills.map((k) => k.name).join(', ') });
                }
                return `# ${skill.name}\n${skill.description}\n\n${skill.body}`.trim();
              },
              'read',
            ),
          ]
        : []),
      def(
        'app_suggest',
        { app: z.string().min(1).max(80), reason: z.string().min(1).max(300) },
        async ({ app, reason }) => {
          const wanted = app.trim().toLowerCase();
          const entry =
            catalogEntry(wanted) ??
            CONNECTION_CATALOG.find((e) => e.name.toLowerCase() === wanted) ??
            searchCatalog(wanted, (c) => c)[0];
          if (!entry) return t('tool.appUnknown', { app });
          const connected = (await s.connections.list()).find(
            (c) =>
              c.catalogId === entry.id &&
              c.status === 'connected' &&
              (c.allBots || c.botIds.includes(bot.id)),
          );
          if (connected) return t('tool.appConnected', { app: entry.name });
          await s.threads.addMessage({
            threadId: thread.id,
            role: 'system',
            author: `bot:${bot.id}`,
            text: reason,
            props: { suggestApp: entry.id },
            turnId: turn.id,
          });
          return t('tool.appSuggested', { app: entry.name });
        },
        'internal',
      ),
      def(
        'quick_replies',
        { options: z.array(z.string().trim().min(1).max(80)).min(1).max(6) },
        async ({ options }) => {
          // Shown as buttons under the reply; a press sends that text as the person's next message.
          await s.threads.addMessage({
            threadId: thread.id,
            role: 'system',
            author: `bot:${bot.id}`,
            text: '',
            props: { quickReplies: [...new Set(options)] },
            turnId: turn.id,
          });
          return t('tool.quickRepliesShown');
        },
        'internal',
      ),
      def(
        'app_add',
        { name: z.string().min(1).max(80), url: z.string().min(1).max(2000) },
        async ({ name, url }) => {
          const input = ConnectionCreate.safeParse({ name, url, auth: 'none' });
          if (!input.success) return t('tool.appBadUrl', { url });
          const known = (await s.connections.list()).find((c) => c.url === input.data.url);
          if (known) return t('tool.appKnown', { name: known.name });
          // Open to this bot only; the person can open it to others in the apps window.
          let c = await s.connections.create({ ...input.data, allBots: false, botIds: [bot.id] });
          if (c.status === 'signed-out') {
            // The server wants a sign-in: it becomes an OAuth connection for the person to sign in to.
            c = await s.connections.update(c.id, { auth: 'oauth' });
            await s.threads.addMessage({
              threadId: thread.id,
              role: 'system',
              author: `bot:${bot.id}`,
              text: t('tool.appSignInCard', { name: c.name }),
              props: { connectionSignIn: c.id },
              turnId: turn.id,
            });
            return t('tool.appNeedsSignIn', { name: c.name });
          }
          if (c.status === 'error') return t('tool.appFailed', { name: c.name, message: c.error ?? '' });
          const tools = c.tools.map((x) => x.name).join(', ') || '-';
          return t('tool.appAdded', { name: c.name, tools });
        },
        // The person approves the new server on a card first.
      ),
      def(
        'routine_create',
        {
          name: z.string().min(1).max(80),
          prompt: z.string().min(1).max(20_000),
          schedule: Schedule,
          missed: z.enum(['run', 'skip']).default('run'),
          /** Give each run the previous run's report, for "what changed since last time" routines. */
          carry_report: z.boolean().default(false),
          /** Run in the main conversation with the person, with its context, not one of its own. */
          in_main: z.boolean().default(false),
          /** Also run once whenever the server starts (on a desktop: when the computer is turned on). */
          on_startup: z.boolean().default(false),
          /** An https page read before each run with no AI; the routine runs only when it changed. */
          watch_url: z
            .string()
            .regex(/^https:\/\/\S+$/)
            .max(2000)
            .optional(),
          /** A connected app's read-only tool called before each run with no AI; it runs only when the answer changed. */
          check_tool: z.string().min(1).max(300).optional(),
          check_args: z.record(z.string(), z.unknown()).optional(),
          /** Also give it a secret address another service can call to start it. */
          webhook: z.boolean().default(false),
          /** Also run when mail arrives at the bot's address, when the mail meets `email_filter`. */
          on_email: z.boolean().default(false),
          email_filter: z.string().max(2000).optional(),
          /** The model its runs use, on the bot's own engine; left out for the bot's own model. */
          model: z.string().trim().max(200).optional(),
        },
        async (a) => {
          const own = await s.routines.list(bot.id);
          const same = own.find((r) => r.name.toLowerCase() === a.name.trim().toLowerCase());
          if (same) return t('tool.routineExists', { name: same.name });
          const check = a.check_tool ? await s.connections.checkFromName(bot.id, a.check_tool) : null;
          if (a.check_tool && !check) return t('tool.routineBadCheck', { tool: a.check_tool });
          const settings = await s.settings.all();
          const r = await s.routines.create({
            botId: bot.id,
            name: a.name.trim(),
            prompt: a.prompt.trim(),
            schedule: a.schedule,
            timezone: settings.timezone,
            enabled: true,
            missed: a.missed,
            carryReport: a.carry_report,
            inMain: a.in_main,
            onStartup: a.on_startup,
            watchUrl: a.watch_url ?? null,
            check: check && { ...check, args: a.check_args ?? {} },
            webhookFilter: '',
            webhookPost: false,
            model: a.model ?? '',
            emailTrigger: a.on_email,
            emailFilter: a.email_filter ?? '',
          });
          const made = t('tool.routineCreated', {
            name: r.name,
            when: describeSchedule(r.schedule, await s.settings.locale()),
            timezone: r.timezone,
          });
          if (!a.webhook) return made;
          const hooked = await s.routines.setWebhook(r.id, true);
          return `${made}\n${t('tool.routineWebhook', { path: `/api/hooks/routines/${r.id}/${hooked.webhookToken}` })}`;
        },
        // The person sees the routine and its schedule on a card before it is made.
      ),
      def(
        'routine_update',
        {
          routine: z.string().min(1).max(200),
          bot: z.string().min(1).max(200).optional(),
          enabled: z.boolean().optional(),
          name: z.string().min(1).max(80).optional(),
          prompt: z.string().min(1).max(20_000).optional(),
          schedule: Schedule.optional(),
          missed: z.enum(['run', 'skip']).optional(),
          carry_report: z.boolean().optional(),
          in_main: z.boolean().optional(),
          on_startup: z.boolean().optional(),
          /** An empty string stops watching the page. */
          watch_url: z
            .union([
              z
                .string()
                .regex(/^https:\/\/\S+$/)
                .max(2000),
              z.literal(''),
            ])
            .optional(),
          /** An empty string removes the check. */
          check_tool: z.string().max(300).optional(),
          check_args: z.record(z.string(), z.unknown()).optional(),
          /** An empty string goes back to the bot's own model. */
          model: z.string().trim().max(200).optional(),
          on_email: z.boolean().optional(),
          email_filter: z.string().max(2000).optional(),
        },
        async (a) => {
          const found = await pickRoutine(a.routine, a.bot);
          if (typeof found === 'string') return found;
          const { routine: r, routines } = found;
          let check: RoutineCheck | null | undefined;
          if (a.check_tool) {
            // The check runs as the routine's own bot, which may be another one for a manager.
            const named = await s.connections.checkFromName(r.botId, a.check_tool);
            if (!named) return t('tool.routineBadCheck', { tool: a.check_tool });
            check = { ...named, args: a.check_args ?? {} };
          } else if (a.check_tool === '') {
            check = null;
          } else if (a.check_args && r.check) {
            check = { ...r.check, args: a.check_args };
          }
          const patch: z.infer<typeof RoutineUpdate> = {
            ...(a.enabled !== undefined && { enabled: a.enabled }),
            ...(a.name !== undefined && { name: a.name.trim() }),
            ...(a.prompt !== undefined && { prompt: a.prompt.trim() }),
            ...(a.schedule !== undefined && { schedule: a.schedule }),
            ...(a.missed !== undefined && { missed: a.missed }),
            ...(a.carry_report !== undefined && { carryReport: a.carry_report }),
            ...(a.in_main !== undefined && { inMain: a.in_main }),
            ...(a.on_startup !== undefined && { onStartup: a.on_startup }),
            ...(a.watch_url !== undefined && { watchUrl: a.watch_url || null }),
            ...(check !== undefined && { check }),
            ...(a.model !== undefined && { model: a.model }),
            ...(a.on_email !== undefined && { emailTrigger: a.on_email }),
            ...(a.email_filter !== undefined && { emailFilter: a.email_filter }),
          };
          if (!Object.keys(patch).length) return t('tool.routineNoChange');
          const rename = patch.name?.toLowerCase();
          const taken =
            rename &&
            routines.find((x) => x.id !== r.id && x.botId === r.botId && x.name.toLowerCase() === rename);
          if (taken) return t('tool.routineExists', { name: taken.name });
          const updated = await s.routines.update(r.id, patch);
          return t('tool.routineUpdated', {
            name: updated.name,
            when: describeSchedule(updated.schedule, await s.settings.locale()),
            timezone: updated.timezone,
            state: t(updated.enabled ? 'tool.routineOn' : 'tool.routineOff'),
          });
        },
        // The person sees which routine changes, and how, on a card first.
      ),
      def(
        'routine_delete',
        { routine: z.string().min(1).max(200), bot: z.string().min(1).max(200).optional() },
        async (a) => {
          const found = await pickRoutine(a.routine, a.bot);
          if (typeof found === 'string') return found;
          await s.routines.remove(found.routine.id);
          return t('tool.routineDeleted', { name: found.routine.name });
        },
        // Deleting cannot be undone: the person approves it on a card first.
      ),
      ...(turn.routineRunId
        ? [
            def(
              'routine_stop',
              { reason: z.string().min(1).max(500) },
              async ({ reason }) => {
                const name = await s.routines.stopFromRun(turn.routineRunId!, reason);
                return name ? t('tool.routineStopped', { name }) : t('tool.routineGone');
              },
              'internal',
            ),
            def(
              'routine_failed',
              { reason: z.string().min(1).max(500) },
              async ({ reason }) => {
                await s.routines.markFailed(turn.routineRunId!, reason);
                return t('tool.routineMarkedFailed');
              },
              'internal',
            ),
          ]
        : []),
      def(
        'skill_save',
        {
          name: z.string().min(1).max(64),
          description: z.string().min(1).max(1024),
          body: z.string().max(50_000),
        },
        async (a) => {
          const name = skillSlug(a.name);
          if (!name) return t('tool.skillBadName');
          const mine = skills.find((k) => k.name === name);
          if (mine) {
            await s.skills.update(mine.id, { description: a.description, body: a.body });
            return t('tool.skillUpdated', { name });
          }
          const taken = (await s.skills.list()).find((k) => k.name === name);
          if (taken) return t('tool.skillTaken', { name });
          await s.skills.create({ name, description: a.description, body: a.body, botIds: [bot.id] });
          return t('tool.skillCreated', { name });
        },
        // The person sees the skill on a card before it is saved.
      ),
      def(
        'my_activity',
        { days: z.number().int().min(1).max(30).default(1), query: z.string().max(200).optional() },
        async ({ days, query }) => {
          const since = new Date(Date.now() - days * 86_400_000);
          const mine = (await s.threads.list(bot.id)).filter(
            (th) => th.id !== thread.id && new Date(th.updatedAt) >= since,
          );
          const out: string[] = [];
          for (const th of mine.slice(0, 15)) {
            const msgs = (await s.threads.messages(th.id, { limit: 40 })).filter(
              (m) =>
                (m.role === 'user' || m.role === 'assistant') &&
                new Date(m.createdAt) >= since &&
                (!query || m.text.toLocaleLowerCase().includes(query.toLocaleLowerCase())),
            );
            if (!msgs.length) continue;
            await shows(msgs.slice(-8).map((m) => m.props));
            out.push(t('tool.conversation', { title: th.title || th.kind, id: th.id }));
            for (const m of msgs.slice(-8))
              out.push(`[${m.createdAt.slice(0, 16)} ${m.role}] ${truncate(m.text, 300)}`);
          }
          return out.join('\n') || t('tool.noConversations');
        },
        'read',
      ),
      def(
        'conversations_search',
        { query: z.string().min(2).max(200), limit: z.number().int().min(1).max(50).default(15) },
        async ({ query, limit }) => {
          const hits = await s.threads.search(query, { botId: bot.id, limit });
          if (!hits.length) return t('tool.notFound');
          const found = await Promise.all(hits.map((h) => s.threads.message(h.messageId).catch(() => null)));
          await shows(found.flatMap((m) => (m ? [m.props] : [])));
          return hits
            .map(
              (h) =>
                `- [${h.createdAt.slice(0, 16)} ${h.role}] ${t('tool.conversationRef', {
                  title: h.threadTitle || h.threadKind,
                  thread: h.threadId,
                  message: h.messageId,
                })}\n  ${h.excerpt}`,
            )
            .join('\n');
        },
        'read',
      ),
      def(
        'message_read',
        { message_id: z.string().min(1).max(64), around: z.number().int().min(0).max(10).default(2) },
        async ({ message_id, around }) => {
          const found = await s.threads.message(message_id).catch(() => null);
          const owner = found ? await s.threads.row(found.threadId).catch(() => null) : null;
          // Another bot's message reads as missing, so its existence is not given away.
          if (!found || owner?.botId !== bot.id) return t('tool.notFound');
          const page = [
            ...(around ? await s.threads.messages(found.threadId, { before: found.id, limit: around }) : []),
            found,
            ...(await s.threads.messagesAfter(found.threadId, found.id, around)),
          ].filter((m) => m.role === 'user' || m.role === 'assistant');
          await shows(page.map((m) => m.props));
          const out = [t('tool.conversation', { title: owner.title || owner.kind, id: owner.id })];
          for (const m of page) {
            const mark = m.id === found.id ? '>>' : '  ';
            out.push(
              `${mark} [${m.createdAt.slice(0, 16)} ${m.role}] ${truncate(m.text, m.id === found.id ? 8000 : 600)}`,
            );
          }
          return out.join('\n');
        },
        'read',
      ),
      def(
        'memory_search',
        { query: z.string().optional(), bot: z.string().optional() },
        async ({ query, bot: botRef }) => {
          const owners = await memoryOwners();
          let ids = [...owners.keys()];
          if (botRef?.trim()) {
            const ref = botRef.trim();
            ids = ids.filter((id) => id === ref || owners.get(id)!.toLowerCase() === ref.toLowerCase());
            if (!ids.length) return t('tool.memoryNotYours');
          }
          // Narrowed to one bot, the list is that bot's notes alone.
          const found = await s.memory.search(ids, query?.trim() || undefined, !botRef?.trim());
          if (!found.length) return t('tool.notFound');
          const whose = (m: Memory) =>
            m.scope === 'user'
              ? t('tool.scopeUser')
              : m.botId === bot.id
                ? t('tool.scopeBot')
                : owners.get(m.botId!);
          return found
            .map(
              (m) =>
                `- [${m.id}] (${whose(m)}${m.site ? ` · ${m.site}` : ''}) ${m.content}${m.sourceUrl ? ` (${t('tool.memorySource', { url: m.sourceUrl })})` : ''}`,
            )
            .join('\n');
        },
        'read',
      ),
      def(
        'memory_write',
        {
          content: z.string().min(1).max(2000),
          scope: z.enum(['bot', 'user']).default('bot'),
          site: z.string().max(253).optional(),
          from: z.string().max(2000).optional(),
        },
        async ({ content, scope, site, from }) => {
          const sourceUrl = from?.trim() ? sourceAddress(from) : null;
          if (sourceUrl === undefined) return t('tool.memoryBadSource', { from: from! });
          let host: string | null = null;
          if (site) {
            try {
              host = siteOf(new URL(site.includes('://') ? site : `https://${site}`).hostname);
            } catch {
              return t('tool.memoryBadSite', { site });
            }
          }
          const clean = redactSecrets(content, t('memory.redacted'));
          const note = { scope, botId: scope === 'bot' ? bot.id : null, content: clean.text, site: host };
          const same = await s.memory.findSame(note);
          if (same) {
            // The fact came up again: the note is in use, though no new one is written.
            await s.memory.markUsed([same.id]);
            return t('tool.memoryAlreadySaved', { id: same.id });
          }
          const held = await memoryGate({
            action: 'write',
            memoryId: null,
            before: null,
            ...note,
            sourceUrl,
          });
          if (held) return held;
          const m = await s.memory.create({
            ...note,
            source: `bot:${bot.id}`,
            threadId: thread.id,
            sourceUrl,
          });
          return clean.redacted
            ? `${t('tool.memorySaved', { id: m.id })} ${t('tool.memoryRedacted')}`
            : t('tool.memorySaved', { id: m.id });
        },
        // The bot keeps its memory itself; everything it writes shows in the memory screen, where the
        // user can change or delete it.
        'internal',
      ),
      def(
        'memory_update',
        {
          id: z.string(),
          content: z.string().trim().min(1).max(2000),
          from: z.string().max(2000).optional(),
        },
        async ({ id, content, from }) => {
          const sourceUrl = from?.trim() ? sourceAddress(from) : null;
          if (sourceUrl === undefined) return t('tool.memoryBadSource', { from: from! });
          const m = await s.memory.get(id);
          if (!s.memory.canEdit(m, (await memoryOwners()).keys())) return t('tool.memoryNotYours');
          const clean = redactSecrets(content, t('memory.redacted'));
          const held = await memoryGate({
            action: 'update',
            memoryId: m.id,
            before: m.content,
            content: clean.text,
            scope: m.scope,
            botId: m.botId,
            site: m.site,
            sourceUrl,
          });
          if (held) return held;
          await s.memory.update(
            id,
            { content: clean.text, ...sourceOf({ threadId: thread.id, sourceUrl }) },
            `bot:${bot.id}`,
          );
          return clean.redacted
            ? `${t('tool.memoryUpdated')} ${t('tool.memoryRedacted')}`
            : t('tool.memoryUpdated');
        },
        'internal',
      ),
      def(
        'memory_forget',
        { id: z.string() },
        async ({ id }) => {
          const m = await s.memory.get(id);
          const owners = await memoryOwners();
          if (!s.memory.canEdit(m, owners.keys())) return t('tool.memoryNotYours');
          const held = await memoryGate({
            action: 'forget',
            memoryId: m.id,
            before: null,
            content: m.content,
            scope: m.scope,
            botId: m.botId,
            site: m.site,
            sourceUrl: null,
          });
          if (held) return held;
          await s.memory.remove(id, `bot:${bot.id}`);
          // A manager deleting another bot's note is told what that bot loses.
          return m.botId && m.botId !== bot.id
            ? t('tool.memoryForgotOther', { bot: owners.get(m.botId)! })
            : t('tool.deleted');
        },
        'internal',
      ),
      def(
        'bots_list',
        {},
        async () => {
          const all = await s.bots.list();
          const peers = all.filter((b) => s.bots.canMessage(bot, b));
          if (!peers.length) return t('tool.noPeers');
          return peers
            .map(
              (b) =>
                `- ${b.name}${b.isManager ? t('bot.managerTag') : ''}${b.description ? `: ${b.description}` : ''}`,
            )
            .join('\n');
        },
        'read',
      ),
      // Splits work off into a conversation of the bot's own, which the person sees in its list.
      def(
        'open_conversation',
        { title: z.string().trim().min(1).max(80), message: z.string().trim().min(1).max(10_000) },
        async ({ title, message }) => {
          if (opened >= MAX_OPENED) return t('tool.conversationsCap', { max: MAX_OPENED });
          opened++;
          const fresh = await s.threads.create(bot.id, { title: title.replace(/\s+/g, ' ') });
          // What this run had read goes along: the message may carry its words.
          const outside = reads();
          await s.threads.addMessage({
            threadId: fresh.id,
            role: 'user',
            author: `bot:${bot.id}`,
            text: message,
            props: { openedFrom: thread.id, ...(outside && { outside }) },
          });
          // A turn of its own, as any message gets; the bot works there while this one goes on.
          await s.turns.enqueue({
            threadId: fresh.id,
            botId: bot.id,
            source: 'bot',
            prompt: t('prompt.openedBySelf', { message }),
            outside,
          });
          await s.threads.addMessage({
            threadId: thread.id,
            role: 'system',
            author: `bot:${bot.id}`,
            text: t('thread.openedNote', { title: fresh.title }),
            props: { openedThread: fresh.id },
            turnId: turn.id,
          });
          return t('tool.conversationOpened', { title: fresh.title });
        },
        'internal',
      ),
      def(
        'bot_send',
        {
          bot: z.string().min(1),
          message: z.string().min(1).max(20_000),
          expect_reply: z.boolean().default(true),
          approval_id: z.string().optional(),
        },
        async ({ bot: ref, message, expect_reply, approval_id }) => {
          const to = await s.bots.resolve(ref, bot);
          const job = await s.jobs.send({
            from: bot,
            fromThreadId: thread.id,
            fromTurnId: turn.id,
            parentJobId: turn.jobId,
            to,
            text: message,
            kind: expect_reply ? 'send' : 'notify',
            approvalId: approval_id ?? null,
            outside: reads(),
          });
          return t(expect_reply ? 'tool.sent' : 'tool.notified', { to: to.name, id: job.id });
        },
        'internal',
        // Asking a bot with looser permissions to act would bypass this bot's own limits.
        async ({ bot: ref }) => {
          const to = await s.bots.resolve(ref, bot).catch(() => null);
          return !!to && STRICTNESS[to.permissionMode] > STRICTNESS[bot.permissionMode];
        },
      ),
      def(
        'bot_status',
        { bot: z.string().min(1) },
        async ({ bot: ref }) => {
          const target = await s.bots.resolve(ref, bot);
          const st = await s.jobs.status(target.id);
          return st.busy
            ? t('tool.busy', { name: target.name, count: st.pendingJobs })
            : t('tool.idle', { name: target.name });
        },
        'read',
      ),
      def(
        'bot_stop',
        { job_id: z.string() },
        async ({ job_id }) => {
          const job = await s.jobs.stop(job_id, bot);
          return t('tool.jobStopped', { id: job.id });
        },
        'internal',
      ),
    ];
    tools.push(
      sendFileTool({ def, services: s, dataDir: this.ctx.config.dataDir, bot, thread, t }),
      showPageTool({ def, services: s, dataDir: this.ctx.config.dataDir, bot, thread, t }),
    );
    // A page becomes a picture in a browser program on this server; without one there is none.
    const executable = this.ctx.browser.executable;
    if (executable) {
      tools.push(
        pageImageTool({
          def,
          services: s,
          dataDir: this.ctx.config.dataDir,
          bot,
          thread,
          browser: { executable, sandbox: this.ctx.config.browserSandbox },
          signal,
          t,
        }),
      );
    }
    // Only a message the person sent gets an emoji back; a turn about their emoji, or another bot's
    // reply, does not. The tool is listed in every turn all the same: the tool list opens the cached
    // prompt, and one that changes between turns of a conversation would reprice all of it.
    tools.push(
      def(
        'react',
        { emoji: z.string().trim().regex(EMOJI) },
        async ({ emoji }) => {
          // In a room every member answers the same message; one emoji would overwrite another's.
          if (turn.source !== 'user' || thread.kind === 'room') return t('tool.reactNotNow');
          const m = await s.threads.react(thread.id, turn.createdAt, emoji);
          return m ? t('tool.reacted', { emoji }) : t('tool.noUserMessage');
        },
        'internal',
      ),
    );
    // The description goes to an outside service, so a bot with the internet off makes no pictures.
    // Listed without a saved key too: the bot then tells the person which key to add.
    if (bot.internet) {
      tools.push(imageTool({ def, services: s, dataDir: this.ctx.config.dataDir, bot, thread, signal, t }));
      tools.push(
        ...apiTools({ def, services: s, bot, thread, turn, signal, unattended, t, sources: opts.apiSources }),
      );
    }
    if (opts.email) tools.push(...emailTools({ def, services: s, bot, address: opts.email, t }));
    tools.push(...ticketTools({ def, services: s, bot, turn, t }));
    tools.push(...tableTools({ def, services: s, botId: bot.id, t, hasTables: opts.hasTables ?? true }));
    // With the internet off the bot gets neither its browser nor its desktop, which reach it too.
    if (this.ctx.browser.available && bot.internet) {
      const askLogin: AskLogin = async (site, host) => {
        const summary = t('browser.loginCard', { bot: bot.name, site });
        const r = await s.approvals.ask({
          threadId: thread.id,
          botId: bot.id,
          turnId: turn.id,
          kind: 'login',
          toolName: 'browser_login',
          input: { site, ...(host && host !== site ? { host } : {}) },
          summary,
          signal,
          timeoutMs: unattended,
          onCreated: async (a) => {
            await s.threads.addMessage({
              threadId: thread.id,
              role: 'approval',
              author: `bot:${bot.id}`,
              text: summary,
              props: { approvalId: a.id },
              turnId: turn.id,
            });
          },
        });
        if (r.status === 'allowed' && r.login) return { ok: true, login: r.login };
        return {
          ok: false,
          message: r.typed
            ? t('approval.typedInstead', { text: r.answer ?? '' })
            : r.timedOut
              ? t('tool.questionTimedOut')
              : r.status === 'expired'
                ? t('tool.questionExpired')
                : t('browser.loginSkipped'),
        };
      };
      tools.push(
        ...browserTools({
          def,
          bot,
          dataDir: this.ctx.config.dataDir,
          threadId: thread.id,
          t,
          browser: this.ctx.browser,
          vault: s.vault,
          askLogin,
          siteNotes: async (host) =>
            bot.memory ? (await s.memory.forSite(bot.id, host)).map((m) => m.content) : [],
          exitNote: () => this.ctx.egress?.takeExitNote(bot.id) ?? null,
        }),
      );
    }
    if (this.ctx.computer && bot.internet) {
      // Commands run in the thread's own work folder, which the desktop sees at the same path.
      const cwd = workspacePaths(this.ctx.config.dataDir, bot.id, thread.id, bot.groupId).threadDir;
      const desk = computerTools({ def, bot, t, computer: this.ctx.computer, cwd });
      // A bot with its own project folder runs commands in this server's sandbox, where that
      // folder is; the desktop does not see it.
      tools.push(...(bot.projectDir ? desk.filter((x) => x.name !== 'run_command') : desk));
    }
    if (bot.isManager) {
      tools.push(...this.managerTools(bot, signal, t, unattended));
      // A manager also reads and tidies the other bots' own notes.
      for (const x of tools) {
        if (MANAGER_MEMORY_TOOLS.has(x.name)) x.description = `${x.description} ${t('tool.memoryManager')}`;
      }
    }
    // With memory off the bot can neither read nor write it.
    return bot.memory ? tools : tools.filter((x) => !MEMORY_TOOLS.has(x.name));
  }

  private managerTools(manager: Bot, signal: AbortSignal, t: T, unattended?: number): AppTool[] {
    const def = definer(t);
    const s = this.services;
    const audit = async (action: string, targetId: string, before: unknown, after: unknown) => {
      await this.ctx.db.insert(schema.auditLog).values({
        id: newId(),
        actor: `bot:${manager.id}`,
        action,
        targetType: 'bot',
        targetId,
        before: before ?? null,
        after: after ?? null,
      });
    };
    /** Why a bot cannot run on this engine and model, or null when it can. */
    const modelProblem = async (engine: 'claude' | 'pi', model: string): Promise<string | null> => {
      if (engine === 'claude') return model.includes('/') ? t('tool.unknownModel', { model }) : null;
      const cut = model.indexOf('/');
      const [provider, id] = [model.slice(0, Math.max(cut, 0)), model.slice(cut + 1)];
      const known: string[] = provider ? await s.keys.models(provider).catch(() => []) : [];
      if (!provider || !id || !known.includes(id)) return t('tool.unknownModel', { model: model || '-' });
      if (!(await s.keys.credential(provider))) return t('tool.noModelKey', { provider });
      return null;
    };
    /**
     * Asks the person on a card in the manager's main conversation; true when they approve. What
     * another bot is told, which files it shares and what it runs on change what that bot does
     * next, so the manager does not change them alone.
     */
    const confirm = async (summary: string, input: Record<string, unknown>, toolName: string) => {
      const approve = t('tool.approve');
      const thread = await s.threads.main(manager.id);
      const r = await s.approvals.ask({
        threadId: thread.id,
        botId: manager.id,
        turnId: null,
        kind: 'question',
        toolName,
        input,
        summary,
        options: [approve, t('tool.reject')],
        signal,
        timeoutMs: unattended,
        onCreated: async (ap) => {
          await s.threads.addMessage({
            threadId: thread.id,
            role: 'approval',
            author: `bot:${manager.id}`,
            text: ap.summary,
            props: { approvalId: ap.id },
          });
        },
      });
      return r.status === 'allowed' && (!r.answer || r.answer === approve);
    };
    const groupId = async (name: string | undefined) => {
      if (!name) return undefined;
      const groups = await s.bots.listGroups();
      const g = groups.find((x) => x.id === name || x.name.toLowerCase() === name.toLowerCase());
      return g ? g.id : (await s.bots.createGroup(name)).id;
    };
    return [
      def(
        'bot_conversations_read',
        { bot: z.string().min(1), limit: z.number().int().min(1).max(100).default(30) },
        async ({ bot: ref, limit }) => {
          const target = await s.bots.resolve(ref, manager);
          const threads = await this.ctx.db
            .select()
            .from(schema.threads)
            .where(eq(schema.threads.botId, target.id))
            .orderBy(desc(schema.threads.updatedAt))
            .limit(5);
          const out: string[] = [];
          for (const th of threads) {
            const msgs = await s.threads.messages(th.id, { limit });
            out.push(t('tool.conversation', { title: th.title || th.kind, id: th.id }));
            for (const m of msgs) out.push(`[${m.role} ${m.author}] ${truncate(m.text, 500)}`);
          }
          return out.join('\n') || t('tool.noConversations');
        },
        'read',
      ),
      def(
        'bot_create',
        {
          name: z.string().min(1).max(60),
          description: z.string().max(500).default(''),
          instructions: z.string().max(20_000).default(''),
          group: z.string().optional(),
          color: z
            .string()
            .regex(/^#[0-9a-f]{6}$/i)
            .optional(),
          engine: z.enum(['claude', 'pi']).optional(),
          model: z.string().max(200).optional(),
        },
        async (a) => {
          // Without a choice the bot starts as the person set new bots to start.
          const settings = await s.settings.all();
          const engine = a.engine ?? settings.defaultEngine;
          const model = a.model?.trim() ?? (engine === 'pi' ? settings.piModel : '');
          const wrong = await modelProblem(engine, model);
          if (wrong) return wrong;
          const created = await s.bots.create({
            name: a.name,
            description: a.description,
            instructions: a.instructions,
            engine,
            model,
            isManager: false,
            // Without a group named, the new bot joins the manager's own section.
            groupId: a.group !== undefined ? ((await groupId(a.group)) ?? null) : manager.groupId,
            color: a.color ?? '#4f6bed',
            avatar: 'shape:blob',
            permissionMode: 'ask',
            internet: false,
            projectDir: null,
            memory: true,
            effort: '',
            toolSelection: ALL_TOOLS,
            instructionsUrl: null,
          });
          await audit('create', created.id, null, created);
          return t('tool.created', { name: created.name, id: created.id });
        },
        // A new bot always starts with the strictest settings: it asks before acting, no internet.
        'internal',
      ),
      def(
        'models_list',
        {},
        async () => {
          const providers = (await s.keys.list()).filter((p) => p.configured);
          const lines = [t('tool.modelsClaude')];
          for (const p of providers) {
            const models = await s.keys.models(p.id).catch(() => []);
            const shown = models.slice(0, 40).map((m) => `${p.id}/${m}`);
            lines.push(
              `- ${p.custom?.name ?? p.id}: ${shown.join(', ')}${models.length > shown.length ? ' …' : ''}`,
            );
          }
          if (!providers.length) lines.push(t('tool.modelsNoKeys'));
          return lines.join('\n');
        },
        'read',
      ),
      def(
        'bot_update',
        {
          bot: z.string().min(1),
          name: z.string().min(1).max(60).optional(),
          description: z.string().max(500).optional(),
          instructions: z.string().max(20_000).optional(),
          group: z.string().optional(),
          color: z
            .string()
            .regex(/^#[0-9a-f]{6}$/i)
            .optional(),
          permission_mode: z.enum(PERMISSION_MODES).optional(),
          internet: z.boolean().optional(),
          engine: z.enum(['claude', 'pi']).optional(),
          model: z.string().max(200).optional(),
        },
        async (a) => {
          const target = await s.bots.resolve(a.bot, manager);
          if (target.isManager && target.id !== manager.id) return t('tool.otherManager');
          // Instructions kept in a document change there, by whoever keeps the document.
          if (a.instructions !== undefined && target.instructionsUrl)
            return t('tool.instructionsLinked', { bot: target.name });
          let modelPatch = {};
          if (a.engine !== undefined || a.model !== undefined) {
            const engine = a.engine ?? target.engine;
            const settings = await s.settings.all();
            const model =
              a.model?.trim() ??
              (engine === target.engine ? target.model : engine === 'pi' ? settings.piModel : '');
            const wrong = await modelProblem(engine, model);
            if (wrong) return wrong;
            modelPatch = { engine, model };
          }
          const loosens =
            (a.permission_mode && STRICTNESS[a.permission_mode] > STRICTNESS[target.permissionMode]) ||
            (a.internet === true && !target.internet);
          // Another bot's instructions, its section (whose files it shares) and what it runs on.
          const other = target.id !== manager.id;
          const changes = other
            ? [
                a.instructions !== undefined && a.instructions !== target.instructions
                  ? t('tool.changeInstructions')
                  : '',
                a.group !== undefined ? t('tool.changeGroup') : '',
                a.engine !== undefined || a.model !== undefined ? t('tool.changeEngine') : '',
              ].filter(Boolean)
            : [];
          if (loosens && !changes.length) {
            const ok = await confirm(
              t('tool.loosenSummary', { manager: manager.name, target: target.name }),
              { bot: target.name, permission_mode: a.permission_mode, internet: a.internet },
              'bot_update',
            );
            if (!ok) return t('tool.loosenDenied');
          } else if (changes.length) {
            if (loosens) changes.push(t('tool.changePermissions'));
            const said = t('tool.changeSummary', {
              manager: manager.name,
              target: target.name,
              what: changes.join(', '),
            });
            const ok = await confirm(
              a.instructions !== undefined ? `${said}\n\n${truncate(a.instructions, 600)}` : said,
              {
                bot: target.name,
                ...(a.instructions !== undefined && { instructions: a.instructions }),
                ...(a.group !== undefined && { group: a.group }),
                ...(a.engine !== undefined && { engine: a.engine }),
                ...(a.model !== undefined && { model: a.model }),
                ...(a.permission_mode !== undefined && { permission_mode: a.permission_mode }),
                ...(a.internet !== undefined && { internet: a.internet }),
              },
              'bot_update',
            );
            if (!ok) return t('tool.changeDenied');
          }
          const patch = {
            ...(a.name !== undefined && { name: a.name }),
            ...(a.description !== undefined && { description: a.description }),
            ...(a.instructions !== undefined && { instructions: a.instructions }),
            ...(a.color !== undefined && { color: a.color }),
            ...(a.permission_mode !== undefined && { permissionMode: a.permission_mode }),
            ...(a.internet !== undefined && { internet: a.internet }),
            ...(a.group !== undefined && { groupId: (await groupId(a.group)) ?? null }),
            ...modelPatch,
          };
          const updated = await s.bots.update(target.id, patch);
          await audit('update', target.id, target, updated);
          return t('tool.updated', { name: updated.name });
        },
        // Loosening a bot's limits, and changing another bot's instructions, section or engine, asks
        // inside the handler; other changes are recorded and undoable.
        'internal',
      ),
      def(
        'bot_profile',
        { bot: z.string().min(1) },
        async ({ bot: ref }) => {
          const target = await s.bots.resolve(ref, manager);
          const groups = await s.bots.listGroups();
          const skills = (await s.skills.forBot(target.id)).map((k) => k.name);
          const routines = await s.routines.list(target.id);
          const apps = (await s.connections.list())
            .filter((c) => c.allBots || c.botIds.includes(target.id))
            .map((c) => c.name);
          return [
            t('tool.profileName', { name: target.name, id: target.id }),
            t('tool.profileDescription', { text: target.description || '-' }),
            t('tool.profileModel', {
              engine: target.engine,
              model: target.model || t('tool.profileDefaultModel'),
            }),
            t('tool.profileMode', { mode: target.permissionMode }),
            t(target.internet ? 'tool.profileInternetOn' : 'tool.profileInternetOff'),
            t('tool.profileGroup', { group: groups.find((g) => g.id === target.groupId)?.name ?? '-' }),
            t('tool.profileSkills', { skills: skills.join(', ') || '-' }),
            t('tool.profileRoutines', { routines: routines.map((r) => r.name).join(', ') || '-' }),
            t('tool.profileApps', { apps: apps.join(', ') || '-' }),
            t('tool.profileInstructions'),
            truncate(target.instructions || '-', 4000),
          ].join('\n');
        },
        'read',
      ),
      def(
        'bot_skill',
        { bot: z.string().min(1), skill: z.string().min(1), on: z.boolean() },
        async (a) => {
          const target = await s.bots.resolve(a.bot, manager);
          if (target.isManager && target.id !== manager.id) return t('tool.otherManager');
          const all = await s.skills.list();
          const skill = all.find((k) => k.name === a.skill.trim().toLowerCase() || k.id === a.skill);
          if (!skill)
            return t('tool.noSuchSkill', { name: a.skill, names: all.map((k) => k.name).join(', ') || '-' });
          // A skill is instructions the bot reads: another bot's are the person's to give.
          if (target.id !== manager.id) {
            const said = t(a.on ? 'tool.skillOnSummary' : 'tool.skillOffSummary', {
              manager: manager.name,
              target: target.name,
              skill: skill.name,
            });
            const ok = await confirm(said, { bot: target.name, skill: skill.name, on: a.on }, 'bot_skill');
            if (!ok) return t('tool.changeDenied');
          }
          await s.skills.setBot(skill.id, target.id, a.on);
          await audit('skill', target.id, null, { skill: skill.name, on: a.on });
          return t(a.on ? 'tool.skillOn' : 'tool.skillOff', { skill: skill.name, name: target.name });
        },
        'internal',
      ),
      def(
        'bot_archive',
        { bot: z.string().min(1) },
        async ({ bot: ref }) => {
          const target = await s.bots.resolve(ref, manager);
          if (target.isManager) return t('tool.managerArchive');
          const archived = await s.bots.archive(target.id);
          await audit('archive', target.id, target, archived);
          return t('tool.archived', { name: target.name });
        },
        // Archiving can be undone from the app.
        'internal',
      ),
    ];
  }

  /** Manager change history (for the UI). */
  async auditFor(botId: string) {
    return this.ctx.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.targetType, 'bot'), eq(schema.auditLog.targetId, botId)))
      .orderBy(desc(schema.auditLog.createdAt))
      .limit(50);
  }
}
