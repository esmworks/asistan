import {
  APPROVAL_TIMED_OUT,
  hideSecretAnswers,
  questionItems,
  type Approval,
  type ApprovalDecision,
  type PermissionMode,
  type PermissionRule,
} from '@yumakbot/shared';
import { and, asc, desc, eq, inArray, isNull, or } from 'drizzle-orm';
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

const globBody = (glob: string) =>
  glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');

/**
 * `glob` as a pattern for the whole text. `prefix:*` is a command and what follows it after a
 * space: `git status:*` covers `git status` and `git status --short`, not `git statusx`.
 */
function globToRegExp(glob: string): RegExp {
  if (glob.endsWith(':*')) return new RegExp(`^${globBody(glob.slice(0, -2))}(?: .*)?$`, 's');
  return new RegExp(`^${globBody(glob)}$`, 's');
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

/** What chains, pipes, redirects or substitutes in a shell command line. */
const SHELL_JOIN = /[;&|<>`\n]|\$\(/;

/**
 * Whether an "always allow" rule lets this call through. A rule for a command (`Bash(npm test*)`)
 * means that command: one with another command chained, piped or substituted after it
 * (`npm test && curl …`) is not covered unless the rule itself spells that out.
 */
export function allowRuleMatches(pattern: string, toolName: string, input: Record<string, unknown>): boolean {
  if (!ruleMatches(pattern, toolName, input)) return false;
  if (toolName !== 'Bash') return true;
  const arg = /\((.*)\)$/s.exec(pattern.trim())?.[1];
  if (arg === undefined) return true;
  return !SHELL_JOIN.test(ruleSubject(toolName, input)) || SHELL_JOIN.test(arg);
}

/**
 * Programs whose words say little about what they do, or that can do anything they are told: an
 * "always allow" from a card for one of these covers that exact command only.
 */
const EXACT_ONLY = new Set([
  ...['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'csh', 'tcsh', 'pwsh', 'powershell', 'cmd'],
  ...['python', 'python2', 'python3', 'node', 'nodejs', 'deno', 'bun', 'perl', 'ruby', 'php', 'lua'],
  ...['osascript', 'awk', 'gawk', 'sed', 'find', 'xargs', 'env', 'sudo', 'doas', 'su', 'exec', 'eval'],
  ...['nohup', 'time', 'timeout', 'nice', 'watch', 'npx', 'pnpx', 'bunx', 'uvx', 'source', '.'],
  ...['rm', 'rmdir', 'mv', 'dd', 'shred', 'truncate', 'chmod', 'chown', 'tee', 'kill', 'pkill'],
  ...['killall', 'curl', 'wget', 'nc', 'ncat', 'netcat', 'socat', 'ssh', 'scp', 'sftp', 'rsync'],
  ...['ftp', 'telnet', 'crontab', 'launchctl', 'systemctl', 'open', 'xdg-open', 'install'],
]);

/** File tools whose path an "always allow" keeps to the folder of the file on the card. */
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * The "always allow" rule a card's step becomes: as narrow as the step. A command keeps its first
 * word and subcommand (`Bash(git status:*)`), or itself when its program can do anything; a file
 * change keeps its folder; a page its site. Null when the step cannot be written as a rule that
 * covers no more than it (a pattern character in it): the answer then counts for this time only.
 */
export function rememberedPattern(toolName: string, input: Record<string, unknown>): string | null {
  const pick = (k: string) => (typeof input[k] === 'string' ? (input[k] as string).trim() : '');
  const plain = (s: string) => !!s && !/[*?]/.test(s);
  if (toolName === 'Bash') {
    const command = pick('command');
    if (!plain(command)) return null;
    const words = command.split(/\s+/);
    const program = words[0]!.replace(/^.*\//, '');
    if (SHELL_JOIN.test(command) || /["'\\$]/.test(command) || EXACT_ONLY.has(program)) {
      return `Bash(${command})`;
    }
    const sub = words[1] && /^[a-z][\w.-]*$/i.test(words[1]) ? ` ${words[1]}` : '';
    return `Bash(${words[0]}${sub}:*)`;
  }
  // A path given from the working folder stays in the bot's folders anyway: the bot alone is
  // the scope then.
  if (FILE_TOOLS.has(toolName)) {
    const path = pick('file_path') || pick('notebook_path') || pick('path');
    if (!path.startsWith('/')) return toolName;
    const dir = path.replace(/\/[^/]*$/, '');
    if (!plain(path) || !dir) return null;
    return `${toolName}(${dir}/*)`;
  }
  if (toolName === 'WebFetch') {
    try {
      const url = new URL(pick('url'));
      return /^https?:$/.test(url.protocol) && plain(url.origin) ? `WebFetch(${url.origin}/*)` : null;
    } catch {
      return null;
    }
  }
  return toolName;
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

/** From the strictest level to the freest. */
export const STRICTNESS: Record<PermissionMode, number> = { readonly: 0, ask: 1, review: 2, auto: 3 };

/** The bot's level, held to `cap` when a stricter bot started the turn. */
export function cappedMode(mode: PermissionMode, cap: PermissionMode | null | undefined): PermissionMode {
  return cap && STRICTNESS[cap] < STRICTNESS[mode] ? cap : mode;
}

/**
 * The level a step is decided at. Text someone else wrote started an `outside` run, so it is
 * never freer than asking: what the text says cannot make the bot change anything by itself.
 */
export function modeFor(mode: PermissionMode, outside: boolean): PermissionMode {
  return outside && mode !== 'readonly' ? 'ask' : mode;
}

export function decide(opts: {
  /** The level the step is decided at: in an `outside` run, as `modeFor` lowers it. */
  mode: PermissionMode;
  toolName: string;
  input: Record<string, unknown>;
  rules: PermissionRule[];
  readOnlyTools: Set<string>;
  /** A run outside text started: "always allow" rules, given for the person's own work, do not count. */
  outside?: boolean;
}): Verdict {
  const { mode, toolName, input, rules } = opts;
  const isRead = READ_ONLY_TOOLS.has(toolName) || opts.readOnlyTools.has(toolName);
  if (blockRuleFor(rules, toolName, input)) return 'block';
  if (mode === 'readonly') return isRead ? 'allow' : 'deny';
  if (askRuleMatches(rules, toolName, input)) return 'ask';
  if (mode === 'auto' || isRead) return 'allow';
  if (opts.outside) return 'ask';
  if (rules.some((r) => r.list === 'allow' && allowRuleMatches(r.pattern, toolName, input))) return 'allow';
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
    return toApproval(await this.row(id));
  }

  private async row(id: string) {
    const [row] = await this.ctx.db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.id, id))
      .limit(1);
    if (!row) throw notFound('approval');
    return row;
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
    /** Asked in a run outside text started; see `answer`. */
    outside?: boolean;
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
        outside: !!opts.outside,
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
      need: row!.kind,
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
    const stored = await this.row(id);
    const current = toApproval(stored);
    if (current.status !== 'pending') throw new HttpError(409, 'error.cardAnswered');
    const status = d.decision === 'allow' ? 'allowed' : 'denied';
    // An "always ask" rule wins over any allow rule, so "always allow" under one would save a rule
    // that never applies and say the bot no longer asks. It counts as "this time" instead. So it
    // does on a card from a run outside text started: the step it allowed was the text's choice.
    // The rule is kept for the bot that asked, and only as wide as the step (see
    // `rememberedPattern`); a step that cannot be written that narrowly counts for this time.
    const pattern = current.kind === 'tool' ? rememberedPattern(current.toolName, current.input) : null;
    const remembered =
      !!d.remember &&
      d.decision === 'allow' &&
      current.kind === 'tool' &&
      !!pattern &&
      !stored.outside &&
      !askRuleMatches(await this.rules(stored.botId), current.toolName, current.input);
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
    const rule =
      remembered && pattern
        ? await this.addRule({
            list: 'allow',
            pattern,
            note: (await serverTranslator(this.ctx))('approval.ruleNote'),
            botId: stored.botId,
          })
        : null;
    // "Never allow": the tool is refused from now on, in every mode, without a card.
    if (d.remember && d.decision === 'deny' && current.kind === 'tool') {
      const t = await serverTranslator(this.ctx);
      await this.addRule({ list: 'block', pattern: current.toolName, note: t('approval.blockNote') });
    }
    this.waiters.get(id)?.resolve({ status, answer: given ?? answer, ...(login && { login }) });
    this.waiters.delete(id);
    if (rule) await this.allowWaiting(rule, id);
    this.ctx.bus.refresh({ scope: 'approvals' });
    return toApproval(row);
  }

  /**
   * After "always allow", other cards still waiting that the new rule covers are answered too, the
   * way it would have: the same bot's, for the same step. A card an "always ask" rule covers keeps
   * waiting.
   */
  private async allowWaiting(rule: PermissionRule, except: string) {
    const ask = (await this.rules(rule.botId ?? undefined)).filter((r) => r.list === 'ask');
    const rows = await this.ctx.db
      .select()
      .from(schema.approvals)
      .where(and(eq(schema.approvals.status, 'pending'), eq(schema.approvals.kind, 'tool')));
    for (const r of rows) {
      // A card from a run outside text started waits for its own answer.
      if (r.id === except || r.outside || !this.waiters.has(r.id)) continue;
      if (rule.botId && r.botId !== rule.botId) continue;
      if (!allowRuleMatches(rule.pattern, r.toolName, r.input)) continue;
      if (ask.some((a) => ruleMatches(a.pattern, r.toolName, r.input))) continue;
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

  /** Every rule; with `botId`, the ones that apply to that bot: its own and those for every bot. */
  async rules(botId?: string | null): Promise<PermissionRule[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.permissionRules)
      .where(
        botId ? or(isNull(schema.permissionRules.botId), eq(schema.permissionRules.botId, botId)) : undefined,
      )
      .orderBy(asc(schema.permissionRules.createdAt));
    return rows.map(toRule);
  }

  async addRule(r: {
    list: 'ask' | 'allow' | 'block';
    pattern: string;
    note: string;
    botId?: string | null;
  }): Promise<PermissionRule> {
    const [row] = await this.ctx.db
      .insert(schema.permissionRules)
      .values({ id: newId(), ...r, botId: r.botId ?? null })
      .returning();
    this.ctx.bus.refresh({ scope: 'rules' });
    return toRule(row!);
  }

  async removeRule(id: string) {
    await this.ctx.db.delete(schema.permissionRules).where(eq(schema.permissionRules.id, id));
    this.ctx.bus.refresh({ scope: 'rules' });
  }
}
