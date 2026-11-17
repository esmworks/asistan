import {
  APPROVAL_TIMED_OUT,
  hideSecretAnswers,
  questionItems,
  type Approval,
  type ApprovalDecision,
  type PermissionMode,
  type PermissionRule,
} from '@yumakbot/shared';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import type { PermissionAnswer } from '../engine/types';
import type { T } from '../i18n';
import { HttpError, newId, notFound, truncate } from '../util';
import { toApproval, toRule } from './mappers';
import { serverTranslator } from './settings';
import type { VaultService } from './vault';

/** Built-in tools that only read inside the allowed folders. */
export const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'TodoWrite', 'NotebookRead']);

/** The string a rule's argument pattern is matched against. */
export function ruleSubject(toolName: string, input: Record<string, unknown>): string {
  const pick = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : null);
  return (
    pick('command') ??
    pick('file_path') ??
    pick('path') ??
    pick('url') ??
    pick('pattern') ??
    pick('query') ??
    (toolName.startsWith('mcp__') ? JSON.stringify(input) : '')
  );
}

function globToRegExp(glob: string): RegExp {
  const esc = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${esc}$`, 's');
}

/** `Tool`, `Tool(arg-glob)`, with `*` wildcards in either part. */
export function ruleMatches(pattern: string, toolName: string, input: Record<string, unknown>): boolean {
  const m = /^([^()]+?)(?:\((.*)\))?$/s.exec(pattern.trim());
  if (!m) return false;
  const [, toolGlob, argGlob] = m;
  if (!globToRegExp(toolGlob!.trim()).test(toolName)) return false;
  if (argGlob === undefined) return true;
  return globToRegExp(argGlob).test(ruleSubject(toolName, input));
}

/** `block`: a block rule covers the call; it is refused in every mode, without a card. */
export type Verdict = 'allow' | 'ask' | 'deny' | 'block';

/** An "always ask" rule covers this request: no one but the person may let it through. */
export function askRuleMatches(rules: PermissionRule[], toolName: string, input: Record<string, unknown>) {
  return !!askRuleFor(rules, toolName, input);
}

/** The "always ask" rule that covers this call, if one does. */
export function askRuleFor(rules: PermissionRule[], toolName: string, input: Record<string, unknown>) {
  return rules.find((r) => r.list === 'ask' && ruleMatches(r.pattern, toolName, input)) ?? null;
}

/** The block rule that covers this call, if one does. */
export function blockRuleFor(rules: PermissionRule[], toolName: string, input: Record<string, unknown>) {
  return rules.find((r) => r.list === 'block' && ruleMatches(r.pattern, toolName, input)) ?? null;
}

export function decide(opts: {
  mode: PermissionMode;
  toolName: string;
  input: Record<string, unknown>;
  rules: PermissionRule[];
  readOnlyTools: Set<string>;
}): Verdict {
  const { mode, toolName, input, rules } = opts;
  const isRead = READ_ONLY_TOOLS.has(toolName) || opts.readOnlyTools.has(toolName);
  if (blockRuleFor(rules, toolName, input)) return 'block';
  if (mode === 'readonly') return isRead ? 'allow' : 'deny';
  if (askRuleMatches(rules, toolName, input)) return 'ask';
  if (mode === 'auto' || isRead) return 'allow';
  if (rules.some((r) => r.list === 'allow' && ruleMatches(r.pattern, toolName, input))) return 'allow';
  return 'ask';
}

export function summarize(toolName: string, input: Record<string, unknown>): string {
  const subject = ruleSubject(toolName, input);
  const name = toolName.startsWith('mcp__yumakbot__') ? toolName.slice('mcp__yumakbot__'.length) : toolName;
  return subject ? `${name}: ${truncate(subject, 200)}` : name;
}

/** What a person typed into a sign-in card. Kept in memory only, never in the approvals table. */
export interface LoginAnswer {
  username: string;
  password: string;
  /** The vault entry, when they chose to save it. */
  savedId: string | null;
}

type Outcome = {
  status: 'allowed' | 'denied' | 'expired';
  answer: string | null;
  login?: LoginAnswer;
  /** Closed unanswered after the unattended wait (see `timeoutMs`). */
  timedOut?: boolean;
  /** The person wrote in the chat instead of answering; `answer` holds their words. */
  typed?: boolean;
};

interface Waiter {
  resolve(d: Outcome): void;
  turnId: string | null;
}

export class ApprovalService {
  private waiters = new Map<string, Waiter>();

  constructor(
    private ctx: Ctx,
    private vault: VaultService,
  ) {}

  async list(opts: { status?: Approval['status'] } = {}): Promise<Approval[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.approvals)
      .where(opts.status ? eq(schema.approvals.status, opts.status) : undefined)
      .orderBy(desc(schema.approvals.createdAt))
      .limit(200);
    return rows.map(toApproval);
  }

  /**
   * The open one-question card a bot is waiting on in a conversation, which a typed message can
   * answer in words; null when there is none, or it asks for a secret or several things at once.
   */
  async typedAnswerable(threadId: string): Promise<Approval | null> {
    const rows = await this.ctx.db
      .select()
      .from(schema.approvals)
      .where(
        and(
          eq(schema.approvals.threadId, threadId),
          eq(schema.approvals.status, 'pending'),
          eq(schema.approvals.kind, 'question'),
          eq(schema.approvals.toolName, 'ask_user'),
        ),
      )
      .orderBy(desc(schema.approvals.createdAt))
      .limit(1);
    const card = rows[0] ? toApproval(rows[0]) : null;
    if (!card || !this.waiters.has(card.id)) return null;
    const { items } = questionItems(card);
    return items.length === 1 && !items[0]!.secret ? card : null;
  }

  /**
   * The open step and sign-in cards a running turn of this conversation waits on. A person who
   * writes in the chat instead of pressing a button has redirected the bot, and these give way.
   */
  async redirectable(threadId: string): Promise<Approval[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.approvals)
      .where(
        and(
          eq(schema.approvals.threadId, threadId),
          eq(schema.approvals.status, 'pending'),
          inArray(schema.approvals.kind, ['tool', 'login']),
        ),
      );
    return rows.filter((r) => this.waiters.has(r.id)).map(toApproval);
  }

  /** Closes a card with the words the person wrote in the chat instead; the bot goes on with them. */
  async redirect(id: string, text: string) {
    const [row] = await this.ctx.db
      .update(schema.approvals)
      .set({ status: 'denied', answer: text, decidedAt: new Date() })
      .where(and(eq(schema.approvals.id, id), eq(schema.approvals.status, 'pending')))
      .returning();
    if (!row) return;
    this.waiters.get(id)?.resolve({ status: 'denied', answer: text, typed: true });
    this.waiters.delete(id);
    this.ctx.bus.refresh({ scope: 'approvals' });
  }

  /** True while a card of this turn waits for the person's answer. */
  waitingOn(turnId: string): boolean {
    for (const w of this.waiters.values()) if (w.turnId === turnId) return true;
    return false;
  }

  async get(id: string): Promise<Approval> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.id, id))
      .limit(1);
    if (!row) throw notFound('approval');
    return toApproval(row);
  }

  /**
   * Create a pending card and wait for the user's answer.
   * The card also shows in the thread as an `approval` message.
   */
  async ask(opts: {
    threadId: string;
    botId: string;
    turnId: string | null;
    kind: 'tool' | 'question' | 'login';
    toolName: string;
    input: Record<string, unknown>;
    summary?: string;
    options?: string[];
    signal?: AbortSignal;
    /** Close the card unanswered after this long (turns nobody watches). */
    timeoutMs?: number;
    onCreated?: (a: Approval) => Promise<void>;
  }): Promise<Outcome & { approvalId: string }> {
    const id = newId();
    const [row] = await this.ctx.db
      .insert(schema.approvals)
      .values({
        id,
        threadId: opts.threadId,
        botId: opts.botId,
        turnId: opts.turnId,
        kind: opts.kind,
        toolName: opts.toolName,
        summary: opts.summary ?? summarize(opts.toolName, opts.input),
        input: opts.input,
        options: opts.options ?? [],
        status: 'pending',
      })
      .returning();
    const result = new Promise<Outcome>((resolve) => {
      this.waiters.set(id, { resolve, turnId: opts.turnId });
    });
    if (opts.signal) {
      const onAbort = () => void this.expire(id);
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = opts.timeoutMs ? setTimeout(() => void this.expire(id, true), opts.timeoutMs) : null;
    timer?.unref();
    await opts.onCreated?.(toApproval(row!));
    this.ctx.bus.refresh({ scope: 'approvals' });
    this.ctx.bus.notice({
      kind: 'needsYou',
      botId: opts.botId,
      threadId: opts.threadId,
      text: truncate(row!.summary, 200),
    });
    try {
      return { ...(await result), approvalId: id };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async answer(id: string, d: ApprovalDecision): Promise<Approval> {
    const current = await this.get(id);
    if (current.status !== 'pending') throw new HttpError(409, 'error.cardAnswered');
    const status = d.decision === 'allow' ? 'allowed' : 'denied';
    // An "always ask" rule wins over any allow rule, so "always allow" under one would save a rule
    // that never applies and say the bot no longer asks. It counts as "this time" instead.
    const remembered =
      !!d.remember &&
      d.decision === 'allow' &&
      current.kind === 'tool' &&
      !askRuleMatches(await this.rules(), current.toolName, current.input);
    let answer = d.answers ? JSON.stringify(d.answers) : (d.answer ?? null);
    /** What the waiting bot gets, when it differs from what the card keeps. */
    let given: string | null | undefined;
    if (current.kind === 'question' && status === 'allowed') {
      const { items } = questionItems(current);
      if (items.some((q) => q.secret)) {
        // A secret answer reaches the waiting bot and nothing else: the card, the database and
        // every screen that shows the card keep it blank.
        if (!this.waiters.has(id)) throw new HttpError(409, 'error.cardAnswered');
        given = answer;
        answer = hideSecretAnswers(items, d.answers ?? (d.answer !== undefined ? [d.answer] : []));
      }
    }
    let login: LoginAnswer | undefined;
    if (current.kind === 'login' && d.decision === 'allow') {
      if (!d.login) throw new HttpError(400, 'error.loginRequired');
      // Nobody else may be waiting on this card any more (e.g. after a restart).
      if (!this.waiters.has(id)) throw new HttpError(409, 'error.cardAnswered');
      // Kept for the whole site, unless the person chose the exact address the card names.
      const exact = d.login.exact && typeof current.input.host === 'string' ? current.input.host : null;
      const site = exact ?? (typeof current.input.site === 'string' ? current.input.site : '');
      const saved = d.login.save
        ? await this.vault.save({ site, username: d.login.username, password: d.login.password })
        : null;
      login = { username: d.login.username, password: d.login.password, savedId: saved?.id ?? null };
      // Only the username is kept on the card.
      answer = d.login.username || null;
    }
    const [row] = await this.ctx.db
      .update(schema.approvals)
      .set({ status, answer, remembered, decidedAt: new Date() })
      .where(and(eq(schema.approvals.id, id), eq(schema.approvals.status, 'pending')))
      .returning();
    if (!row) throw new HttpError(409, 'error.cardAnswered');
    if (remembered) {
      const t = await serverTranslator(this.ctx);
      await this.addRule({ list: 'allow', pattern: current.toolName, note: t('approval.ruleNote') });
    }
    // "Never allow": the tool is refused from now on, in every mode, without a card.
    if (d.remember && d.decision === 'deny' && current.kind === 'tool') {
      const t = await serverTranslator(this.ctx);
      await this.addRule({ list: 'block', pattern: current.toolName, note: t('approval.blockNote') });
    }
    this.waiters.get(id)?.resolve({ status, answer: given ?? answer, ...(login && { login }) });
    this.waiters.delete(id);
    if (remembered) await this.allowWaiting(current.toolName, id);
    this.ctx.bus.refresh({ scope: 'approvals' });
    return toApproval(row);
  }

  /**
   * After "always allow", other cards still waiting for the same tool are answered too, the way
   * the new rule would have; a card an "always ask" rule covers keeps waiting.
   */
  private async allowWaiting(toolName: string, except: string) {
    const ask = (await this.rules()).filter((r) => r.list === 'ask');
    const rows = await this.ctx.db
      .select()
      .from(schema.approvals)
      .where(
        and(
          eq(schema.approvals.status, 'pending'),
          eq(schema.approvals.kind, 'tool'),
          eq(schema.approvals.toolName, toolName),
        ),
      );
    for (const r of rows) {
      if (r.id === except || !this.waiters.has(r.id)) continue;
      if (ask.some((rule) => ruleMatches(rule.pattern, r.toolName, r.input))) continue;
      const [done] = await this.ctx.db
        .update(schema.approvals)
        .set({ status: 'allowed', decidedAt: new Date() })
        .where(and(eq(schema.approvals.id, r.id), eq(schema.approvals.status, 'pending')))
        .returning();
      if (!done) continue;
      this.waiters.get(r.id)?.resolve({ status: 'allowed', answer: null });
      this.waiters.delete(r.id);
    }
  }

  async expire(id: string, timedOut = false) {
    const answer = timedOut ? APPROVAL_TIMED_OUT : null;
    await this.ctx.db
      .update(schema.approvals)
      .set({ status: 'expired', answer, decidedAt: new Date() })
      .where(and(eq(schema.approvals.id, id), eq(schema.approvals.status, 'pending')));
    this.waiters.get(id)?.resolve({ status: 'expired', answer, ...(timedOut && { timedOut }) });
    this.waiters.delete(id);
    this.ctx.bus.refresh({ scope: 'approvals' });
  }

  /** On boot nothing is waiting any more. */
  async expireAllPending() {
    await this.ctx.db
      .update(schema.approvals)
      .set({ status: 'expired', decidedAt: new Date() })
      .where(eq(schema.approvals.status, 'pending'));
  }

  /** A user-approved record, for carrying approval to another bot. */
  async verifiedApproval(id: string): Promise<Approval | null> {
    try {
      const a = await this.get(id);
      return a.status === 'allowed' ? a : null;
    } catch {
      return null;
    }
  }

  toAnswer(
    r: { status: string; answer: string | null; timedOut?: boolean; typed?: boolean },
    t: T,
  ): PermissionAnswer {
    if (r.status === 'allowed') return { behavior: 'allow' };
    if (r.typed) return { behavior: 'deny', message: t('approval.typedInstead', { text: r.answer ?? '' }) };
    if (r.timedOut) return { behavior: 'deny', message: t('approval.timedOut') };
    if (r.status === 'expired') return { behavior: 'deny', message: t('approval.expired') };
    return {
      behavior: 'deny',
      message: r.answer ? t('approval.deniedWith', { answer: r.answer }) : t('approval.denied'),
    };
  }

  async rules(): Promise<PermissionRule[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.permissionRules)
      .orderBy(asc(schema.permissionRules.createdAt));
    return rows.map(toRule);
  }

  async addRule(r: {
    list: 'ask' | 'allow' | 'block';
    pattern: string;
    note: string;
  }): Promise<PermissionRule> {
    const [row] = await this.ctx.db
      .insert(schema.permissionRules)
      .values({ id: newId(), ...r })
      .returning();
    this.ctx.bus.refresh({ scope: 'rules' });
    return toRule(row!);
  }

  async removeRule(id: string) {
    await this.ctx.db.delete(schema.permissionRules).where(eq(schema.permissionRules.id, id));
    this.ctx.bus.refresh({ scope: 'rules' });
  }
}
