import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  describeAction,
  INTL_LOCALE,
  selectsTools,
  toolPicker,
  type Bot,
  type Effort,
  type Locale,
} from '@yumakbot/shared';
import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import {
  isSilentReply,
  maybeSilentReply,
  toolPermName,
  type Engine,
  type PermissionAnswer,
  type TurnOutcome,
} from '../engine/types';
import { translator, type T } from '../i18n';
import { askRuleFor, askRuleMatches, decide, READ_ONLY_TOOLS, summarize } from '../services/approvals';
import { publicHost } from '../services/skill-link';
import type { PlanItem } from '../engine/types';
import { isUniqueViolation, newId, readableError, truncate } from '../util';
import { elicitContent, elicitQuestions } from '../connections/elicit';
import { askPerson } from '../tools';
import { sandboxFor, workspacePaths } from '../workspace';
import { buildSystemPrompt, HANDOFF_MESSAGES, handoffPrompt, nowLine, postedText } from './prompt';
import { catastrophic, readsOnlyWithin } from './safety';
import { TurnWatchdog, type Stall } from './watchdog';
import type { Services } from '../services';

export type TurnRow = typeof schema.turns.$inferSelect;
export type TurnSource = TurnRow['source'];

const PRIORITY: Record<TurnSource, number> = { user: 0, reaction: 1, routine: 1, bot: 2 };

/** What Claude Code asks before a sandboxed command reaches a host the sandbox does not list. */
const SANDBOX_NETWORK = 'SandboxNetworkAccess';
/** The host of an address a tool was given; empty when it is not one. */
function urlHost(url: unknown): string {
  try {
    return typeof url === 'string' ? new URL(url).hostname : '';
  } catch {
    return '';
  }
}

/** Built-in tools that only read from the web. */
const WEB_READS = ['WebSearch', 'WebFetch', SANDBOX_NETWORK];

/** Turns the person started from the app, who is likely there to answer a card. */
/** How model servers say a request does not fit the context window (local servers included). */
export const CONTEXT_FULL =
  /context[ _](length|window)|maximum context|too many tokens|exceeds? the (model'?s? )?(context|maximum)|n_ctx|prompt is too long|\b413\b|(request|payload|entity) too large/i;

/** Where a conversation keeps the pages of the MCP app views shown in it. */
export const APP_DIR = '.apps';

/**
 * The call result a view gets back when it opens, kept small: the structured part goes first, then
 * long texts are cut, so a big result does not bloat every load of the conversation.
 */
export function viewResult(result: { content?: unknown; structuredContent?: unknown; isError?: boolean }) {
  const max = 200_000;
  let r: Record<string, unknown> = { ...result };
  if (JSON.stringify(r).length > max) {
    const { structuredContent: _drop, ...rest } = r;
    r = rest;
  }
  if (JSON.stringify(r).length > max && Array.isArray(r.content)) {
    r.content = (r.content as Record<string, unknown>[])
      .filter((c) => c.type === 'text')
      .map((c) => ({ type: 'text', text: String(c.text ?? '').slice(0, 20_000) }));
  }
  return r;
}

/** Why a stalled turn was stopped, naming the tool that never ended when there was one. */
export function stallText(stall: Stall, t: T): string {
  const minutes = Math.max(1, Math.round(stall.ms / 60_000));
  if (stall.cause === 'silent') return t('turn.stalled', { minutes });
  // `mcp__server__name` reads as the tool's own name.
  const tool = stall.tool.split('__').at(-1) || stall.tool;
  return t('turn.stalledTool', { minutes, tool });
}

/** Whether the text names a skill as `$name`, as a word of its own. */
export function taggedSkill(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s(])\\$${escaped}(?![\\w-])`).test(text);
}

export const attended = (source: TurnSource) => source === 'user' || source === 'reaction';

interface Running {
  turn: TurnRow;
  controller: AbortController;
  done: Promise<void>;
  /** Waiting messages the person asked to hand to this turn while it runs. */
  steers: { turnId: string; messageId: string; prompt: string }[];
  /** Hand-overs still being written down; the turn waits for them before it ends. */
  handing: Promise<void>[];
}

export type TurnFinishedHook = (turn: TurnRow, outcome: TurnOutcome) => Promise<void>;

const interrupted = (message: string): TurnOutcome => ({
  ok: false,
  kind: 'interrupted',
  message,
  text: '',
  sessionId: null,
});

/**
 * Runs engine turns: one per thread, at most N at once, user turns first.
 * Queued turns live in the database so they survive restarts.
 */

/** A message stopped by the usage limit runs again this long after the limit resets. */
export const LIMIT_RETRY_DELAY_MS = 30_000;
/**
 * Keeps a connection's answer that is too long for the model in the conversation's folder, under
 * tool-results/, where the bot can read or search it with its own tools.
 */
function keepToolResult(threadDir: string) {
  return async (name: string, text: string) => {
    const dir = join(threadDir, 'tool-results');
    await mkdir(dir, { recursive: true });
    const safe = name.replace(/[^\w.-]+/g, '_').slice(0, 60);
    const file = join(dir, `${safe}-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
    await writeFile(file, text, { mode: 0o600 });
    return file;
  };
}

export class TurnManager {
  private running = new Map<string, Running>();
  private hooks: TurnFinishedHook[] = [];
  private scheduling: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private ctx: Ctx,
    private services: Services,
    private engineFor: (bot: Bot) => Engine,
    private reviewer?: () => Engine,
  ) {}

  onFinished(hook: TurnFinishedHook) {
    this.hooks.push(hook);
  }

  /** Mark turns that were running when the server stopped. */
  async recover() {
    const t = await this.services.settings.translator();
    const stale = await this.ctx.db
      .update(schema.turns)
      .set({ status: 'interrupted', finishedAt: new Date(), error: t('turn.serverRestarted') })
      .where(eq(schema.turns.status, 'running'))
      .returning();
    for (const turn of stale) {
      await this.services.threads.addMessage({
        threadId: turn.threadId,
        role: 'system',
        author: 'system',
        text: t('turn.interruptedByRestart'),
        turnId: turn.id,
      });
      await this.runHooks(turn, interrupted(t('turn.serverRestarted')));
    }
    await this.services.approvals.expireAllPending();
    await this.resumeRetries();
    this.schedule();
  }

  /** Waiting retries of messages the usage limit stopped, by the error message that announced them. */
  private retries = new Map<string, ReturnType<typeof setTimeout>>();
  /** Turns that are themselves such a retry; they are not retried again. */
  private retried = new Set<string>();

  /**
   * The person's message stopped by the usage limit runs again by itself once the limit resets, so
   * it is not lost; deleting the error line calls the retry off.
   */
  private scheduleRetry(messageId: string, turn: TurnRow, at: Date) {
    clearTimeout(this.retries.get(messageId));
    // setTimeout holds at most about 24 days; a later reset is picked up at the next start.
    const wait = Math.min(Math.max(0, at.getTime() - Date.now()), 2 ** 31 - 1);
    const timer = setTimeout(() => {
      this.retries.delete(messageId);
      void this.retryNow(messageId, turn).catch((err) => console.warn('limit retry', err));
    }, wait);
    timer.unref?.();
    this.retries.set(messageId, timer);
  }

  private async retryNow(messageId: string, turn: TurnRow) {
    if (this.stopped) return;
    const note = await this.services.threads.message(messageId).catch(() => null);
    if (!note || !note.props.retryAt) return;
    const { retryAt: _done, ...props } = note.props;
    await this.services.threads.updateMessage(messageId, { props: { ...props, retried: true } });
    const again = await this.enqueue({
      threadId: turn.threadId,
      botId: turn.botId,
      source: 'user',
      prompt: turn.prompt,
    });
    this.retried.add(again.id);
  }

  /**
   * Runs the person's request again, from the note its failed or stopped turn left. Only for the
   * conversation's latest turn, with nothing running or waiting there: a request run again after
   * later ones would answer out of order. Null when that is not the case.
   */
  async retry(messageId: string): Promise<TurnRow | null> {
    const note = await this.services.threads.message(messageId);
    const ended = note.role === 'error' || (note.role === 'system' && note.props.kind === 'interrupted');
    if (!ended || !note.turnId || note.props.retried) return null;
    const [turn] = await this.ctx.db.select().from(schema.turns).where(eq(schema.turns.id, note.turnId));
    if (!turn || turn.source !== 'user' || this.isRunning(turn.threadId)) return null;
    const [later] = await this.ctx.db
      .select({ id: schema.turns.id })
      .from(schema.turns)
      .where(and(eq(schema.turns.threadId, turn.threadId), gt(schema.turns.createdAt, turn.createdAt)))
      .limit(1);
    if (later) return null;
    // A retry set for when the usage limit lifts is this one now.
    const timer = this.retries.get(note.id);
    if (timer) clearTimeout(timer);
    this.retries.delete(note.id);
    const { retryAt: _, ...props } = note.props;
    await this.services.threads.updateMessage(note.id, { props: { ...props, retried: true } });
    return this.enqueue({ threadId: turn.threadId, botId: turn.botId, source: 'user', prompt: turn.prompt });
  }

  /** After a restart: the retries still waiting are set again. */
  private async resumeRetries() {
    const notes = await this.ctx.db
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.role, 'error'), sql`${schema.messages.props} ? 'retryAt'`));
    for (const n of notes) {
      const at = new Date(String((n.props as { retryAt?: unknown }).retryAt));
      if (!n.turnId || Number.isNaN(at.getTime())) continue;
      const [turn] = await this.ctx.db
        .select()
        .from(schema.turns)
        .where(eq(schema.turns.id, n.turnId))
        .limit(1);
      if (turn) this.scheduleRetry(n.id, turn, at);
    }
  }

  async enqueue(t: {
    threadId: string;
    botId: string;
    source: TurnSource;
    prompt: string;
    jobId?: string | null;
    routineRunId?: string | null;
  }): Promise<TurnRow> {
    const [row] = await this.ctx.db
      .insert(schema.turns)
      .values({
        id: newId(),
        threadId: t.threadId,
        botId: t.botId,
        source: t.source,
        status: 'queued',
        prompt: t.prompt,
        jobId: t.jobId ?? null,
        routineRunId: t.routineRunId ?? null,
      })
      .returning();
    this.emitState(t.threadId, t.botId);
    this.schedule();
    return row!;
  }

  /** Stops the work a bot-to-bot request started: its running turn, and its turns not yet started. */
  async stopJob(jobId: string): Promise<boolean> {
    const t = await this.services.settings.translator();
    let found = false;
    for (const r of this.running.values()) {
      if (r.turn.jobId === jobId) {
        r.controller.abort();
        found = true;
      }
    }
    const dropped = await this.ctx.db
      .update(schema.turns)
      .set({ status: 'interrupted', finishedAt: new Date(), error: t('turn.stoppedByUser') })
      .where(and(eq(schema.turns.jobId, jobId), eq(schema.turns.status, 'queued')))
      .returning();
    for (const turn of dropped) {
      this.emitState(turn.threadId, turn.botId);
      await this.runHooks(turn, interrupted(t('turn.stoppedByUser')));
    }
    return found || dropped.length > 0;
  }

  /**
   * Messages the person sent while the bot was busy start one turn together, in their order, so
   * the bot answers them at once instead of one after another.
   */
  private async gather(turn: TurnRow): Promise<TurnRow> {
    const later = await this.ctx.db
      .select()
      .from(schema.turns)
      .where(
        and(
          eq(schema.turns.threadId, turn.threadId),
          // In a room other members wait in the same conversation; theirs stay theirs.
          eq(schema.turns.botId, turn.botId),
          eq(schema.turns.status, 'queued'),
          eq(schema.turns.source, 'user'),
        ),
      )
      .orderBy(asc(schema.turns.createdAt));
    if (!later.length) return turn;
    const prompt = [turn.prompt, ...later.map((t) => t.prompt)].join('\n\n');
    const ids = later.map((t) => t.id);
    await this.ctx.db
      .update(schema.messages)
      .set({ turnId: turn.id })
      .where(and(eq(schema.messages.threadId, turn.threadId), inArray(schema.messages.turnId, ids)));
    await this.ctx.db.delete(schema.turns).where(inArray(schema.turns.id, ids));
    const [merged] = await this.ctx.db
      .update(schema.turns)
      .set({ prompt })
      .where(eq(schema.turns.id, turn.id))
      .returning();
    return merged ?? { ...turn, prompt };
  }

  /** Gives a turn that has not started a new prompt; false once it has. */
  async editQueued(turnId: string, prompt: string): Promise<boolean> {
    this.unsteer(turnId);
    const rows = await this.ctx.db
      .update(schema.turns)
      .set({ prompt })
      .where(and(eq(schema.turns.id, turnId), eq(schema.turns.status, 'queued')))
      .returning({ id: schema.turns.id });
    return rows.length > 0;
  }

  /** Drops a turn that has not started; false once it has. */
  async cancelQueued(turnId: string): Promise<boolean> {
    this.unsteer(turnId);
    const t = await this.services.settings.translator();
    const [row] = await this.ctx.db
      .update(schema.turns)
      .set({ status: 'interrupted', finishedAt: new Date(), error: t('turn.stoppedByUser') })
      .where(and(eq(schema.turns.id, turnId), eq(schema.turns.status, 'queued')))
      .returning();
    if (!row) return false;
    this.emitState(row.threadId, row.botId);
    return true;
  }

  /** Drops a thread's turns that have not started, leaving the running one be. */
  async dropQueued(threadId: string): Promise<number> {
    const t = await this.services.settings.translator();
    // A turn that hands over another bot's answer stays: that answer is not sent again.
    const dropped = await this.ctx.db
      .update(schema.turns)
      .set({ status: 'interrupted', finishedAt: new Date(), error: t('turn.stoppedByUser') })
      .where(
        and(
          eq(schema.turns.threadId, threadId),
          eq(schema.turns.status, 'queued'),
          isNull(schema.turns.jobId),
        ),
      )
      .returning();
    for (const r of this.running.values()) {
      r.steers = r.steers.filter((st) => !dropped.some((d) => d.id === st.turnId));
    }
    if (dropped[0]) this.emitState(threadId, dropped[0].botId);
    for (const turn of dropped) await this.runHooks(turn, interrupted(t('turn.stoppedByUser')));
    return dropped.length;
  }

  /** Stop the running turn of a thread and drop its queued turns. */
  async interrupt(threadId: string): Promise<boolean> {
    const t = await this.services.settings.translator();
    const dropped = await this.ctx.db
      .update(schema.turns)
      .set({ status: 'interrupted', finishedAt: new Date(), error: t('turn.stoppedByUser') })
      .where(and(eq(schema.turns.threadId, threadId), eq(schema.turns.status, 'queued')))
      .returning();
    let found = dropped.length > 0;
    for (const r of this.running.values()) {
      if (r.turn.threadId === threadId) {
        r.controller.abort();
        found = true;
      }
    }
    if (dropped[0]) this.emitState(threadId, dropped[0].botId);
    // A dropped turn never reaches `finish`; its routine run or job still has to end.
    for (const turn of dropped) await this.runHooks(turn, interrupted(t('turn.stoppedByUser')));
    return found;
  }

  /** Stops one turn and waits until it has ended, its routine run or job included. */
  async stopTurn(turnId: string): Promise<void> {
    const entry = this.running.get(turnId);
    if (!entry) return;
    entry.controller.abort();
    await entry.done;
  }

  isRunning(threadId: string) {
    return [...this.running.values()].some((r) => r.turn.threadId === threadId);
  }

  private emits = new Set<Promise<void>>();

  async shutdown() {
    this.stopped = true;
    for (const timer of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
    // A fill already under way may still start a turn; let it, so the abort below reaches it.
    await this.scheduling;
    for (const r of this.running.values()) r.controller.abort();
    await Promise.allSettled([...this.running.values()].map((r) => r.done));
    await Promise.allSettled([...this.emits]);
  }

  /** Wait until nothing is running or queued (tests). */
  async idle(timeoutMs = 20_000) {
    const start = Date.now();
    for (;;) {
      await this.scheduling;
      const queued = await this.ctx.db
        .select({ id: schema.turns.id })
        .from(schema.turns)
        .where(inArray(schema.turns.status, ['queued', 'running']))
        .limit(1);
      if (!queued.length && this.running.size === 0) return;
      if (Date.now() - start > timeoutMs) throw new Error('Turns did not finish in time');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  schedule() {
    this.scheduling = this.scheduling.then(() => this.fill()).catch((err) => console.error('scheduler', err));
  }

  private async fill() {
    if (this.stopped) return;
    const free = this.ctx.config.maxConcurrentTurns - this.running.size;
    if (free <= 0) return;
    const queued = await this.ctx.db
      .select()
      .from(schema.turns)
      .where(eq(schema.turns.status, 'queued'))
      .orderBy(asc(schema.turns.createdAt))
      .limit(200);
    queued.sort(
      (a, b) => PRIORITY[a.source] - PRIORITY[b.source] || a.createdAt.getTime() - b.createdAt.getTime(),
    );
    const busy = new Set([...this.running.values()].map((r) => r.turn.threadId));
    let slots = free;
    for (const t of queued) {
      if (slots <= 0 || this.stopped) break;
      if (busy.has(t.threadId)) continue;
      busy.add(t.threadId);
      try {
        const [started] = await this.ctx.db
          .update(schema.turns)
          .set({ status: 'running', startedAt: new Date() })
          .where(and(eq(schema.turns.id, t.id), eq(schema.turns.status, 'queued')))
          .returning();
        if (!started) continue;
        slots--;
        const turn = started.source === 'user' ? await this.gather(started) : started;
        await this.services.threads.startedOn(turn.id, turn.threadId);
        this.launch(turn);
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
  }

  private launch(turn: TurnRow) {
    const controller = new AbortController();
    const entry: Running = { turn, controller, done: Promise.resolve(), steers: [], handing: [] };
    this.running.set(turn.id, entry);
    this.emitState(turn.threadId, turn.botId);
    entry.done = this.execute(turn, controller)
      .catch(async (err) => {
        console.error('turn failed', err);
        await this.finish(turn, {
          ok: false,
          kind: 'engine',
          message: (err as Error).message,
          text: '',
          sessionId: null,
        }).catch(() => {});
      })
      .then(async () => {
        await Promise.allSettled(entry.handing);
      })
      .finally(() => {
        this.running.delete(turn.id);
        // What was not handed over stays waiting and gets its own turn.
        for (const s of entry.steers) void this.services.threads.markSteering(s.messageId, false);
        this.emitState(turn.threadId, turn.botId);
        this.schedule();
      });
  }

  /**
   * Hands a message still waiting for its turn to the turn running in that conversation: the bot
   * reads it at its next step instead of after it finishes. False when nothing runs there.
   */
  async steer(threadId: string, turnId: string, messageId: string): Promise<boolean> {
    const entry = [...this.running.values()].find((r) => r.turn.threadId === threadId);
    if (!entry) return false;
    const [queued] = await this.ctx.db
      .select()
      .from(schema.turns)
      .where(and(eq(schema.turns.id, turnId), eq(schema.turns.status, 'queued')))
      .limit(1);
    if (!queued || !this.running.has(entry.turn.id)) return false;
    if (!entry.steers.some((s) => s.turnId === turnId)) {
      entry.steers.push({ turnId, messageId, prompt: queued.prompt });
    }
    await this.services.threads.markSteering(messageId, true);
    return true;
  }

  /** A waiting message changed or taken back is no longer handed over. */
  private unsteer(turnId: string) {
    for (const r of this.running.values()) r.steers = r.steers.filter((s) => s.turnId !== turnId);
  }

  /** The handed-over messages, taken once; each becomes part of the running turn. */
  private takeSteers(entry: Running, t: T): string[] {
    const taken = entry.steers;
    entry.steers = [];
    for (const s of taken) {
      entry.handing.push(
        (async () => {
          await this.ctx.db
            .update(schema.turns)
            .set({ status: 'done', finishedAt: new Date() })
            .where(and(eq(schema.turns.id, s.turnId), eq(schema.turns.status, 'queued')));
          await this.services.threads.updateMessage(s.messageId, { turnId: entry.turn.id });
          await this.services.threads.markSteering(s.messageId, false);
          await this.services.threads.startedOn(entry.turn.id, entry.turn.threadId);
        })().catch((err) => console.warn('steer', err)),
      );
    }
    return taken.map((s) => t('prompt.steered', { text: s.prompt }));
  }

  private async execute(turn: TurnRow, controller: AbortController) {
    const { threads, bots, memory, approvals } = this.services;
    // Spending is checked as a turn starts; one already running finishes.
    const month = await this.services.usage.month();
    if (month.limitUsd > 0 && month.costUsd >= month.limitUsd) {
      const t = await this.services.settings.translator();
      throw new Error(
        t('turn.spendLimit', { spent: month.costUsd.toFixed(2), limit: month.limitUsd.toFixed(2) }),
      );
    }
    const thread = await threads.row(turn.threadId);
    const bot = await bots.get(turn.botId);
    const paths = workspacePaths(this.ctx.config.dataDir, bot.id, thread.id, bot.groupId);
    const sandbox = sandboxFor(paths, {
      projectDir: bot.projectDir,
      internet: bot.internet,
      readOnly: bot.permissionMode === 'readonly',
    });
    const allBots = await bots.list();
    const peers = allBots.filter((b) => bots.canMessage(bot, b));
    const settings = await this.services.settings.all();
    const timezone = settings.timezone;
    const locale = await this.services.settings.locale();
    const t = translator(locale);
    const skills = await this.services.skills.forBot(bot.id);
    // In a room every member keeps its own session, and its prompt is the room's new lines.
    const inRoom = thread.kind === 'room';
    // The person is in the room while its bots talk, as with their own messages.
    const present = attended(turn.source) || inRoom;
    const systemPrompt = buildSystemPrompt({
      bot,
      goal: thread.goal,
      paths,
      cwd: sandbox.cwd,
      // A bot with memory off sees none, not even the person's shared notes.
      memory: bot.memory ? await memory.visibleTo(bot.id) : { user: [], bot: [] },
      profile: {
        name: settings.userName,
        addressAs: settings.addressAs,
        occupation: settings.occupation,
        focus: settings.focus,
        about: settings.aboutMe,
      },
      peers,
      timezone,
      locale,
      browser: this.ctx.browser.available && bot.internet,
      onUserComputer: this.ctx.config.onUserComputer,
      routines: await this.services.routines.list(bot.isManager ? undefined : bot.id),
      skills,
      room: inRoom ? await this.services.rooms.context(thread.id, bot, settings.userName, t) : undefined,
    });
    // The bot's tool selection narrows what it is given; the rest never reaches the model.
    const pickTool = toolPicker(bot.toolSelection);
    const allTools = [
      ...this.services.tools.forTurn({
        bot,
        thread,
        turn,
        signal: controller.signal,
        t,
        skills,
        // Claude keeps its plan with its own to-do tool; other engines get this one.
        plan: bot.engine === 'pi' ? (items) => showPlan(items) : undefined,
      }),
      ...(await this.services.connections.toolsFor(
        bot.id,
        t,
        controller.signal,
        async (form, connection) => {
          const items = elicitQuestions(form, [t('elicit.yes'), t('elicit.no')]);
          if (!items.length) return { action: 'accept', content: {} };
          const r = await askPerson(this.services, {
            bot,
            thread,
            turn,
            signal: controller.signal,
            timeoutMs: present ? undefined : this.ctx.config.unattendedApprovalMs,
            title: truncate(form.message ? `${connection}: ${form.message}` : connection, 120),
            items: items.map((q) => ({ question: q.question, options: q.options })),
          });
          if (r.status !== 'allowed') return { action: r.status === 'denied' ? 'decline' : 'cancel' };
          const content = elicitContent(items, r.answers);
          return content ? { action: 'accept', content } : { action: 'decline' };
        },
        keepToolResult(paths.threadDir),
        async (view) => {
          // The view's page waits in the conversation folder; the card names it by id.
          const appId = newId();
          await mkdir(join(paths.threadDir, APP_DIR), { recursive: true });
          await writeFile(join(paths.threadDir, APP_DIR, `${appId}.html`), view.page.html);
          await threads.addMessage({
            threadId: thread.id,
            role: 'system',
            author: `bot:${bot.id}`,
            text: t('app.viewShown', { name: view.connection }),
            props: {
              app: {
                id: appId,
                connectionId: view.connectionId,
                tool: view.tool,
                connect: view.page.connect,
                resources: view.page.resources,
                input: view.input,
                result: viewResult(view.result),
              },
            },
            turnId: turn.id,
          });
        },
      )),
    ];
    const tools = allTools.filter((x) => pickTool(toolPermName(x)));
    // Internal app tools, and connection tools marked read, run without a card; `ask` rules can
    // still require one.
    const readOnlyTools = new Set(tools.filter((t) => t.internal || t.readOnly).map(toolPermName));
    // With the internet on, searching and reading pages are reads like opening one in the browser.
    if (bot.internet) for (const name of WEB_READS) readOnlyTools.add(name);
    const connectionNames = await this.services.connections.names();
    // Apps the bot counts on that are not connected now: it says so instead of guessing why their
    // tools are gone. Per turn, so the system prompt stays the same and keeps its cache.
    const down = await this.services.connections.unavailableFor(bot.id);
    const appsDown = down.length
      ? t('prompt.appsDown', {
          apps: down.map((c) => `${c.name} (${t(`prompt.appDown.${c.status}`)})`).join(', '),
        })
      : '';

    let streamed = '';
    let shown = 0;
    // With a desktop, commands run there (run_command) instead of in this server's sandbox; a bot
    // with its own project folder keeps the sandbox, since the desktop cannot see that folder.
    // Whether a step that changes something (not a read) was let through in this turn.
    let acted = false;
    // The desktop has its own way out to the internet, so a bot with the internet off keeps to the
    // sandbox here, where every host a command reaches is decided below.
    const shell: 'computer' | 'sandbox' =
      this.ctx.computer && !bot.projectDir && bot.internet ? 'computer' : 'sandbox';
    const canUseTool = async (raw: {
      toolName: string;
      input: Record<string, unknown>;
    }): Promise<PermissionAnswer> => {
      // A command on the bot's desktop is the same to the user as Bash here: same card wording,
      // and the same "always ask" / "always allow" rules apply.
      const ask =
        raw.toolName === 'mcp__yumakbot__run_command'
          ? { toolName: 'Bash', input: { command: raw.input.command } }
          : raw;
      // A tool the bot's selection leaves out is never run, even when the engine offers it by itself.
      if (raw.toolName !== SANDBOX_NETWORK && !pickTool(raw.toolName)) {
        return { behavior: 'deny', message: t('turn.toolOff') };
      }
      // ask_user handles its own card.
      if (ask.toolName === 'mcp__yumakbot__ask_user') return { behavior: 'allow' };
      // A sandboxed command reaching a host: the internet switch decides, never a card. This
      // computer and the private network stay closed either way.
      if (ask.toolName === SANDBOX_NETWORK) {
        if (!bot.internet) return { behavior: 'deny', message: t('turn.internetOff') };
        const host = typeof ask.input.host === 'string' ? ask.input.host : '';
        return (await publicHost(host))
          ? { behavior: 'allow' }
          : { behavior: 'deny', message: t('turn.privateHost', { host }) };
      }
      // Some commands no mode, rule or card lets through.
      if (
        ask.toolName === 'Bash' &&
        typeof ask.input.command === 'string' &&
        catastrophic(ask.input.command)
      ) {
        return { behavior: 'deny', message: t('turn.safetyFloor') };
      }
      let free = readOnlyTools;
      const appTool = tools.find((t) => toolPermName(t) === ask.toolName);
      const gated = !!appTool?.gated && (await appTool.gated(ask.input));
      if (gated) {
        free = new Set(readOnlyTools);
        free.delete(ask.toolName);
      }
      // Reading a page is a plain read only on the public internet: an address on this computer or
      // the private network goes by the bot's permission level, as any other step.
      if (
        ask.toolName === 'WebFetch' &&
        free.has(ask.toolName) &&
        !(await publicHost(urlHost(ask.input.url)))
      ) {
        free = new Set(free);
        free.delete(ask.toolName);
      }
      // Read for every call: "Hep izin ver" on an earlier card of this turn must count here, and so
      // must an approval level the person changed while the bot works.
      const rules = await approvals.rules();
      const mode = await bots.get(bot.id).then(
        (b) => b.permissionMode,
        () => bot.permissionMode,
      );
      // A plain read of the bot's own folders needs no card, at any level: an unattended routine
      // must not wait on one to read its own notes.
      if (
        ask.toolName === 'Bash' &&
        shell === 'sandbox' &&
        typeof ask.input.command === 'string' &&
        !askRuleMatches(rules, ask.toolName, ask.input) &&
        readsOnlyWithin(
          ask.input.command,
          sandbox.cwd,
          [sandbox.cwd, paths.botFiles, paths.groupFiles].filter((d): d is string => !!d),
        )
      ) {
        return { behavior: 'allow' };
      }
      const verdict = decide({
        mode,
        toolName: ask.toolName,
        input: ask.input,
        rules,
        readOnlyTools: free,
      });
      if (verdict === 'allow') return { behavior: 'allow' };
      if (verdict === 'deny') {
        return { behavior: 'deny', message: t('turn.readOnly') };
      }
      // Review mode: a small model may let a clearly safe request through. Never for what an
      // "always ask" rule covers, what only the person may approve, or a step that sends.
      // Why the reviewer left it to the person, when it said; the card shows it.
      let reviewReason = '';
      if (
        mode === 'review' &&
        !gated &&
        ask.input.sends !== true &&
        !askRuleMatches(rules, ask.toolName, ask.input)
      ) {
        const review = await this.reviewed({ bot, thread, turn, ask, locale, signal: controller.signal });
        if (review.allowed) return { behavior: 'allow' };
        reviewReason = review.reason;
      }
      // The card names an "always ask" rule that covers this call, in every mode: "always allow"
      // cannot outdo it, so the card does not offer that. A bot allowed to go ahead by itself
      // stops only for such a rule.
      const askRule = askRuleFor(rules, ask.toolName, ask.input)?.pattern;
      const held = askRule ? (mode === 'auto' || mode === 'review' ? { heldBy: askRule } : { askRule }) : {};
      const result = await approvals.ask({
        threadId: thread.id,
        botId: bot.id,
        turnId: turn.id,
        kind: 'tool',
        toolName: ask.toolName,
        input: ask.input,
        summary: describeAction(ask.toolName, ask.input, {
          bot: bot.name,
          locale,
          service: appTool?.server ? connectionNames.get(appTool.server) : undefined,
        }).want,
        signal: controller.signal,
        timeoutMs: present ? undefined : this.ctx.config.unattendedApprovalMs,
        onCreated: async (a) => {
          await threads.addMessage({
            threadId: thread.id,
            role: 'approval',
            author: `bot:${bot.id}`,
            text: a.summary,
            props: {
              approvalId: a.id,
              ...held,
              ...(reviewReason ? { reviewReason: truncate(reviewReason, 300) } : {}),
            },
            turnId: turn.id,
          });
          this.emitState(thread.id, bot.id);
        },
      });
      this.emitState(thread.id, bot.id);
      return approvals.toAnswer(result, t);
    };

    const engine = this.engineFor(bot);
    const roomPrompt = (fresh: boolean) =>
      this.services.rooms.prompt({ roomId: thread.id, bot, turn, fresh, t });
    // A turn that starts a new session in a thread with a past hands the recent exchange over.
    const handoff = async () =>
      inRoom
        ? roomPrompt(true)
        : handoffPrompt({
            messages: (await threads.messages(thread.id, { limit: 2 * HANDOFF_MESSAGES })).filter(
              (m) => new Date(m.createdAt) <= turn.createdAt,
            ),
            prompt: asked,
            names: new Map([
              ...(settings.userName ? [['user', settings.userName] as const] : []),
              ...allBots.map((b) => [`bot:${b.id}`, b.name] as const),
            ]),
            locale,
          });
    // Skills the person named with `$name` are read before the work starts.
    const tagged = skills.filter((k) => taggedSkill(turn.prompt, k.name));
    const asked = tagged.length
      ? `${t('prompt.skillTagged', { names: tagged.map((k) => k.name).join(', ') })}\n\n${turn.prompt}`
      : turn.prompt;
    // Webhook posts land in the conversation without a turn, so a live session never saw them; the
    // ones since the bot last ran here come with this message. A handoff carries them already.
    const withPosts = async (prompt: string) => {
      const [before] = await this.ctx.db
        .select({ createdAt: schema.turns.createdAt })
        .from(schema.turns)
        .where(and(eq(schema.turns.threadId, thread.id), lt(schema.turns.createdAt, turn.createdAt)))
        .orderBy(desc(schema.turns.createdAt))
        .limit(1);
      const posts = (await threads.messages(thread.id, { limit: 50 }))
        .filter((m) => {
          const at = new Date(m.createdAt);
          return m.props.posted && at <= turn.createdAt && (!before || at > before.createdAt);
        })
        .slice(-5);
      if (!posts.length) return prompt;
      return `${t('prompt.postedSince', { posts: posts.map((m) => postedText(m, t)).join('\n\n') })}\n\n${prompt}`;
    };
    // The bot's plan is one message per turn, rewritten as the plan changes.
    let planMessage: Promise<string> | null = null;
    const showPlan = async (items: PlanItem[]) => {
      try {
        if (!planMessage) {
          planMessage = threads
            .addMessage({
              threadId: thread.id,
              role: 'system',
              author: `bot:${bot.id}`,
              text: '',
              props: { plan: items },
              turnId: turn.id,
            })
            .then((r) => r.message.id);
          await planMessage;
        } else {
          await threads.updateMessage(await planMessage, { props: { plan: items } });
        }
      } catch (err) {
        console.warn('plan', err);
      }
    };
    const saved = inRoom
      ? await this.services.rooms.session(thread.id, bot.id)
      : { id: thread.engineSessionId, costUsd: thread.engineSessionCostUsd };
    let session = saved.id;
    // What the session had cost by its last run: the engine prices this run as what it adds.
    let sessionCost = saved.costUsd;
    const saveSession = (id: string | null) =>
      inRoom ? this.services.rooms.setSession(thread.id, bot.id, id) : threads.setSession(thread.id, id);
    const saveSessionCost = (costUsd: number) =>
      inRoom
        ? this.services.rooms.setSessionCost(thread.id, bot.id, costUsd)
        : threads.setSessionCost(thread.id, costUsd);
    // A routine may name a cheaper or stronger model for its runs, on the bot's own engine.
    const [routineModel] = turn.routineRunId
      ? await this.ctx.db
          .select({ model: schema.routines.model })
          .from(schema.routineRuns)
          .innerJoin(schema.routines, eq(schema.routines.id, schema.routineRuns.routineId))
          .where(eq(schema.routineRuns.id, turn.routineRunId))
      : [];
    const model =
      routineModel?.model ||
      bot.model ||
      (bot.engine === 'claude' ? settings.defaultModel : '') ||
      this.ctx.config.claudeModel;
    await this.ctx.db
      .update(schema.turns)
      .set({ engine: bot.engine, model })
      .where(eq(schema.turns.id, turn.id));
    // The tool running now, for the "Working" line; told only when it changes.
    const runningTools = new Map<string, string>();
    let shownTool: string | null = null;
    const showTool = (tool: { id: string; name: string; running: boolean }) => {
      if (tool.running) runningTools.set(tool.id, tool.name);
      else runningTools.delete(tool.id);
      const now = [...runningTools.values()].at(-1) ?? null;
      if (now === shownTool) return;
      shownTool = now;
      this.ctx.bus.tool({ threadId: thread.id, tool: now });
    };
    // A turn the engine leaves silent for too long is stopped, and says why, instead of keeping the
    // conversation busy until someone notices.
    const watchdog = new TurnWatchdog({
      limits: this.ctx.config.stall,
      waiting: () => approvals.waitingOn(turn.id),
      onStall: () => controller.abort(),
    });
    /** `backup`: a run on the backup model, which leaves the thread's own session alone. */
    const run = async (prompt: string, backup?: string) => {
      const outcome = await (backup ? this.engineFor({ ...bot, engine: 'pi' }) : engine).run({
        turnId: turn.id,
        threadId: thread.id,
        botId: bot.id,
        model: backup ?? model,
        // The bot's own effort wins over the setting for every bot; the setting is Claude's alone.
        ...(!backup && (bot.effort || (bot.engine === 'claude' && settings.effort))
          ? { effort: (bot.effort || settings.effort) as Effort }
          : {}),
        prompt,
        context: [nowLine(new Date(), timezone, locale), appsDown].filter(Boolean).join('\n'),
        sessionId: backup ? null : session,
        sessionCostUsd: backup ? null : sessionCost,
        systemPrompt,
        locale,
        sandbox,
        shell,
        tools,
        ...(selectsTools(bot.toolSelection) && { pickTool }),
        canUseTool: async (ask) => {
          const answer = await canUseTool(ask);
          if (
            answer.behavior === 'allow' &&
            !READ_ONLY_TOOLS.has(ask.toolName) &&
            !readOnlyTools.has(ask.toolName)
          )
            acted = true;
          return answer;
        },
        onActivity: (tool) => {
          watchdog.activity(tool);
          if (tool) showTool(tool);
        },
        onText: (delta) => {
          watchdog.activity();
          streamed += delta;
          // The start of an answer that may still be the silent reply is held back until it is not.
          if (maybeSilentReply(streamed)) return;
          this.ctx.bus.delta({ threadId: thread.id, turnId: turn.id, text: streamed.slice(shown) });
          shown = streamed.length;
        },
        onSession: (sessionId) => {
          if (backup) return;
          if (sessionId !== session) void saveSession(sessionId);
          session = sessionId;
        },
        onPlan: (items) => void showPlan(items),
        onLimitNear: (info) => void this.warnLimit(turn, info),
        // A line in the chat marks where the bot's memory of the conversation became a summary.
        onCompacted: () =>
          void threads.addMessage({
            threadId: thread.id,
            role: 'system',
            author: 'system',
            text: t('turn.compacted'),
            props: { kind: 'compacted' },
            turnId: turn.id,
          }),
        steering: () => {
          const entry = this.running.get(turn.id);
          return entry ? this.takeSteers(entry, t) : [];
        },
        signal: controller.signal,
      });
      // A run that said nothing of its cost leaves the total as it was: the next run counts it.
      if (!backup && outcome.sessionCostUsd != null) {
        sessionCost = outcome.sessionCostUsd;
        await saveSessionCost(outcome.sessionCostUsd);
      }
      return outcome;
    };
    let outcome: TurnOutcome;
    // What runs of this turn that were replaced by another (a new session, the backup) spent.
    let spent = 0;
    try {
      outcome = await run(session ? await (inRoom ? roomPrompt(false) : withPosts(asked)) : await handoff());
      if (!outcome.ok && outcome.kind === 'lostSession') {
        // Its transcript is gone: a new session takes the thread over, once, with the recent exchange.
        session = null;
        await saveSession(null);
        spent += outcome.costUsd ?? 0;
        outcome = await run(await handoff());
        if (!outcome.ok && outcome.kind === 'lostSession') outcome = { ...outcome, kind: 'engine' };
      }
      if (!outcome.ok && outcome.kind === 'engine' && session && CONTEXT_FULL.test(outcome.message)) {
        // The conversation no longer fits the model: a new session carries on, once, with the recent
        // exchange, instead of every later message failing the same way.
        await threads.addMessage({
          threadId: thread.id,
          role: 'system',
          author: 'system',
          text: t('turn.contextHandoff'),
          props: { kind: 'contextHandoff' },
          turnId: turn.id,
        });
        session = null;
        await saveSession(null);
        streamed = '';
        shown = 0;
        spent += outcome.costUsd ?? 0;
        outcome = await run(await handoff());
      }
      const backup = settings.backupModel;
      // A turn that already changed something is never run again from the start: the backup would
      // repeat what was done (a sent mail, a written file). It ends with its error instead.
      const blocked = !outcome.ok && (outcome.kind === 'limit' || outcome.transient === true) && !acted;
      if (!outcome.ok && blocked && backup && backup !== model && !controller.signal.aborted) {
        // The usage limit is spent: the backup model carries this turn with the recent exchange, so
        // the work goes on instead of waiting for the limit to lift. The thread keeps its own session.
        await threads.addMessage({
          threadId: thread.id,
          role: 'system',
          author: 'system',
          text: t(outcome.kind === 'limit' ? 'turn.backupModel' : 'turn.backupBusy', { model: backup }),
          props: { kind: 'backupModel' },
          turnId: turn.id,
        });
        await this.ctx.db
          .update(schema.turns)
          .set({ engine: 'pi', model: backup })
          .where(eq(schema.turns.id, turn.id));
        streamed = '';
        shown = 0;
        spent += outcome.costUsd ?? 0;
        outcome = await run(await handoff(), backup);
        outcome.sessionId = null;
      }
    } finally {
      watchdog.stop();
    }
    if (watchdog.stalled && !outcome.ok && outcome.kind === 'interrupted') {
      outcome = { ...outcome, kind: 'stalled', message: stallText(watchdog.stalled, t) };
    }
    if (!outcome.ok && !outcome.text && streamed) outcome.text = streamed;
    if (spent) outcome = { ...outcome, costUsd: (outcome.costUsd ?? 0) + spent };
    await this.finish(turn, outcome, { acted });
  }

  /** True when the reviewer let the request through; the conversation shows that it did and why. */
  private async reviewed(o: {
    bot: Bot;
    thread: { id: string };
    turn: TurnRow;
    ask: { toolName: string; input: Record<string, unknown> };
    locale: Locale;
    signal: AbortSignal;
  }): Promise<{ allowed: boolean; reason: string }> {
    const no = { allowed: false, reason: '' };
    const engine = this.reviewer?.();
    if (!engine?.review) return no;
    let verdict;
    try {
      verdict = await engine.review({
        toolName: o.ask.toolName,
        input: o.ask.input,
        bot: { name: o.bot.name, description: o.bot.description },
        request: o.turn.prompt,
        locale: o.locale,
        signal: o.signal,
      });
    } catch (err) {
      console.warn(`Review failed, asking instead: ${(err as Error).message}`);
      return no;
    }
    if (o.signal.aborted) return no;
    if (verdict.decision !== 'allow') return { allowed: false, reason: verdict.reason };
    const t = translator(o.locale);
    const action = summarize(o.ask.toolName, o.ask.input);
    await this.services.threads.addMessage({
      threadId: o.thread.id,
      role: 'system',
      author: 'system',
      text: verdict.reason
        ? t('review.allowed', { action, reason: verdict.reason })
        : t('review.allowedNoReason', { action }),
      props: { review: true },
      turnId: o.turn.id,
    });
    return { allowed: true, reason: verdict.reason };
  }

  /** `acted`: a step that changes something (not a read) was let through during the turn. */
  private async finish(turn: TurnRow, outcome: TurnOutcome, o: { acted?: boolean } = {}) {
    const { threads } = this.services;
    const t = await this.services.settings.translator();
    const kind = (await threads.row(turn.threadId)).kind;
    if (outcome.sessionId) {
      if (kind === 'room') await this.services.rooms.setSession(turn.threadId, turn.botId, outcome.sessionId);
      else await threads.setSession(turn.threadId, outcome.sessionId);
    }
    // Bot-to-bot exchanges run on their own; the person hears of the ones that reach them.
    const heard = kind !== 'bot';
    if (outcome.text.trim() && !isSilentReply(outcome.text)) {
      await threads.addMessage({
        threadId: turn.threadId,
        role: 'assistant',
        author: `bot:${turn.botId}`,
        text: outcome.text,
        turnId: turn.id,
        props: outcome.ok ? {} : { partial: true },
      });
      if (heard && outcome.ok) {
        this.ctx.bus.notice({
          kind: 'reply',
          botId: turn.botId,
          threadId: turn.threadId,
          text: truncate(outcome.text.trim(), 200),
        });
      }
    }
    if (outcome.ok && !outcome.text.trim() && turn.source === 'user') {
      // Without a word, a finished turn looks like one that never ran.
      await threads.addMessage({
        threadId: turn.threadId,
        role: 'system',
        author: 'system',
        text: t('turn.noReply'),
        props: { kind: 'noReply' },
        turnId: turn.id,
      });
    }
    if (!outcome.ok) {
      // A person's message stopped by Claude's usage limit tries again once the limit resets.
      const retryAt =
        outcome.kind === 'limit' &&
        !outcome.provider &&
        outcome.resetsAt &&
        turn.source === 'user' &&
        // Sending the request again would repeat what the turn already did (a sent mail, a
        // written file); the person says what is left instead.
        !o.acted &&
        !this.retried.has(turn.id)
          ? new Date(outcome.resetsAt.getTime() + LIMIT_RETRY_DELAY_MS)
          : null;
      const text =
        outcome.kind === 'auth'
          ? t('turn.noClaudeLogin')
          : outcome.kind === 'limit'
            ? outcome.provider
              ? readableError(outcome.message)
              : await this.limitText(outcome.resetsAt ?? null)
            : outcome.kind === 'interrupted'
              ? t('turn.stopped')
              : outcome.kind === 'stalled'
                ? outcome.message
                : CONTEXT_FULL.test(outcome.message)
                  ? t('turn.contextFull', { message: readableError(outcome.message) })
                  : t('turn.error', { message: readableError(outcome.message) });
      const { message: note } = await threads.addMessage({
        threadId: turn.threadId,
        role: outcome.kind === 'interrupted' ? 'system' : 'error',
        author: 'system',
        text: retryAt
          ? `${text} ${t('turn.limitRetry')}`
          : outcome.kind === 'limit' && o.acted && turn.source === 'user'
            ? `${text} ${t('turn.limitActed')}`
            : text,
        props: {
          kind: outcome.kind,
          ...(retryAt && { retryAt: retryAt.toISOString() }),
          // Out of steps mid-task: the person can tell it to go on from where it stopped.
          ...(outcome.stepLimit && { stepLimit: true }),
        },
        turnId: turn.id,
      });
      if (retryAt) this.scheduleRetry(note.id, turn, retryAt);
      if (heard && outcome.kind !== 'interrupted') {
        this.ctx.bus.notice({
          kind: 'error',
          botId: turn.botId,
          threadId: turn.threadId,
          text: truncate(text, 200),
        });
      }
    }
    await this.ctx.db
      .update(schema.turns)
      .set({
        status: outcome.ok ? 'done' : outcome.kind === 'interrupted' ? 'interrupted' : 'error',
        finishedAt: new Date(),
        error: outcome.ok ? null : outcome.message,
        // A failed turn spent too, and counts toward the monthly limit.
        costUsd: outcome.costUsd ?? null,
      })
      .where(eq(schema.turns.id, turn.id));
    await this.runHooks(turn, outcome);
  }

  /** The reset of the usage window last warned about; one warning per window is enough. */
  private warnedFor: number | null = null;

  /** Says once per usage window, in the conversation that hit it, that the limit is close. */
  private async warnLimit(turn: TurnRow, info: { used: number | null; resetsAt: Date | null }) {
    const window = info.resetsAt?.getTime() ?? 0;
    if (this.warnedFor === window) return;
    this.warnedFor = window;
    try {
      const t = await this.services.settings.translator();
      const percent = info.used === null ? null : Math.round(info.used * 100);
      const text = percent
        ? t('turn.limitNear', { percent, time: info.resetsAt ? await this.resetClock(info.resetsAt) : '—' })
        : t('turn.limitNearPlain');
      await this.services.threads.addMessage({
        threadId: turn.threadId,
        role: 'system',
        author: 'system',
        text,
        props: { kind: 'limitNear' },
        turnId: turn.id,
      });
    } catch (err) {
      console.warn('limit warning', err);
    }
  }

  /** When the usage window resets, in the person's time zone; the date too when it is not today. */
  private async resetClock(resetsAt: Date): Promise<string> {
    const { timezone } = await this.services.settings.all();
    const locale = await this.services.settings.locale();
    const sameDay = resetsAt.getTime() - Date.now() < 20 * 3_600_000;
    return resetsAt.toLocaleString(INTL_LOCALE[locale], {
      timeZone: timezone,
      ...(sameDay ? { timeStyle: 'short' } : { dateStyle: 'medium', timeStyle: 'short' }),
    });
  }

  /** The usage limit as the person reads it: when it lifts, in their own time zone. */
  private async limitText(resetsAt: Date | null): Promise<string> {
    const t = await this.services.settings.translator();
    if (!resetsAt) return t('turn.limit');
    return t('turn.limitUntil', { time: await this.resetClock(resetsAt) });
  }

  private async runHooks(turn: TurnRow, outcome: TurnOutcome) {
    for (const hook of this.hooks) {
      try {
        await hook(turn, outcome);
      } catch (err) {
        console.error('turn hook', err);
      }
    }
  }

  private emitState(threadId: string, botId: string) {
    const p = this.services.threads
      .state(threadId)
      .then((state) => {
        // A running entry may not be persisted as visible state yet.
        const live = this.isRunning(threadId) && state === 'idle' ? 'running' : state;
        this.ctx.bus.turn({ threadId, botId, state: live });
      })
      .catch((err) => {
        if (!this.stopped) console.error('turn state', err);
      })
      .finally(() => this.emits.delete(p));
    this.emits.add(p);
  }
}
