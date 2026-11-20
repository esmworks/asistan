import { createHmac } from 'node:crypto';
import type { Bot, CanaryAlarm } from '@yumakbot/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import type { AppTool } from '../engine/types';
import type { T } from '../i18n';
import { reachesOut } from '../runtime/outside';
import { newId, notFound } from '../util';
import { STRICTNESS } from './approvals';
import type { Services } from './index';

/**
 * Trip-wires for a bot that is being steered by text it read (a page, a mail, a webhook, another
 * bot). Nothing the person asks for would ever touch them, so touching one is proof:
 *
 * - the private line of the bot's prompt: a token only the prompt holds, which the bot is told
 *   never to repeat. Seeing it in a tool's input or in a reply means something made the bot copy
 *   its prompt out;
 * - a trap key: a key the person made up that guards nothing and goes nowhere, offered to bots
 *   like their real ones.
 */

/** What every token looks like, so a stray one can be taken out of any text without knowing whose. */
const TOKEN_SHAPE = /cnry-[0-9a-f]{24}/gi;

/** The most nesting and values of one tool input that are looked through. */
const MAX_DEPTH = 12;
const MAX_VALUES = 5_000;

/** The most outside sources an alarm names. */
export const MAX_SOURCES = 8;

/** Text with every token taken out. */
export function scrubCanary(text: string): string {
  return text.replace(TOKEN_SHAPE, '[…]');
}

/** Every string in a value, keys included, nested as deep as `MAX_DEPTH`. */
function strings(value: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown, depth: number) => {
    if (out.length >= MAX_VALUES) return;
    if (typeof v === 'string') out.push(v);
    else if (depth >= MAX_DEPTH) return;
    else if (Array.isArray(v)) for (const x of v) visit(x, depth + 1);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        out.push(k);
        visit(x, depth + 1);
      }
    }
  };
  visit(value, 0);
  return out;
}

/** A text percent-decoded, as far as it decodes. */
function decoded(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * The token as base64 would write it inside a longer text, wherever that text starts: its three
 * alignments, each cut to the characters the neighbours cannot change.
 */
function base64Forms(token: string): string[] {
  const forms: string[] = [];
  for (let pad = 0; pad < 3; pad++) {
    const bytes = Buffer.concat([Buffer.alloc(pad, 0x20), Buffer.from(token)]);
    const text = bytes.toString('base64').replace(/=+$/, '');
    const head = pad === 0 ? 0 : pad === 1 ? 2 : 3;
    const tail = bytes.length % 3 === 0 ? 0 : 1;
    forms.push(text.slice(head, text.length - tail));
  }
  return forms;
}

/**
 * Whether `value` carries `token`: as it is, percent-encoded (every letter written as %xx too),
 * in hex, or in base64 (the standard and the URL alphabet). A token split up or hidden some other
 * way is not found; this is a trip-wire for a bot copying text out, not a filter.
 */
export function carriesToken(token: string, value: unknown): boolean {
  const hex = Buffer.from(token).toString('hex');
  const b64 = base64Forms(token);
  for (const s of strings(value)) {
    if (s.length < token.length) continue;
    const once = decoded(s);
    for (const text of new Set([s, once, decoded(once)])) {
      const lower = text.toLowerCase();
      if (lower.includes(token) || lower.includes(hex)) return true;
      const standard = text.replace(/-/g, '+').replace(/_/g, '/');
      if (b64.some((f) => standard.includes(f))) return true;
    }
  }
  return false;
}

/** Why a step was refused. */
export interface CanaryHit {
  wire: 'prompt' | 'key';
  /** For a trap key: its name. */
  keyName?: string;
}

/** What a trap key is for the check: its name, where it pretends to be, and the bots it is shown to. */
interface Trap {
  name: string;
  origin: string;
  botIds: string[] | null;
}

type Row = typeof schema.canaryAlarms.$inferSelect;

/** An alarm as the app shows it. */
const toAlarm = (r: Row, botName: string): CanaryAlarm => ({
  id: r.id,
  wire: r.wire,
  botId: r.botId,
  botName,
  threadId: r.threadId,
  tool: r.tool,
  keyName: r.keyName,
  sources: r.sources,
  movedFrom: r.movedFrom,
  createdAt: r.createdAt.toISOString(),
  seenAt: r.seenAt?.toISOString() ?? null,
});

export class CanaryService {
  constructor(
    private ctx: Ctx,
    private services: Services,
  ) {}

  /**
   * The private token of a bot's prompt. It is worked out from the data folder's secret and the
   * bot, so it is never stored: it stays the same from turn to turn (the prompt keeps its cache),
   * is different for every bot, and is in no export or backup.
   */
  token(botId: string): string {
    const mac = createHmac('sha256', this.services.vault.contentKey()).update(`canary:${botId}`);
    return `cnry-${mac.digest('hex').slice(0, 24)}`;
  }

  /** Whether `value` (a tool's input, a reply) carries the bot's private token. */
  leaks(botId: string, value: unknown): boolean {
    return carriesToken(this.token(botId), value);
  }

  /**
   * Whether a step is one of the wires: its input carries the bot's token, it names a trap key
   * the bot is shown (`api_request`, `credential_request`, or an API source that sends one), or
   * it reaches out to a trap key's address. `tool` is the app's own tool the step is, when it is
   * one; `host` the address a sandboxed command reaches, when that is the step.
   */
  async screen(o: {
    bot: Pick<Bot, 'id'>;
    /** Whom the turn works for; null in a conversation that uses nothing of anyone's own. */
    own: string | null;
    toolName: string;
    input: Record<string, unknown>;
    tool?: AppTool;
  }): Promise<CanaryHit | null> {
    if (this.leaks(o.bot.id, o.input)) return { wire: 'prompt' };
    if (!o.own) return null;
    const traps = await this.services.apiCredentials.traps(o.own);
    if (!traps.length) return null;
    const mine = (x: Trap) => !x.botIds || x.botIds.includes(o.bot.id);
    // A key named in a request or an ask for one; resolved by what the bot is shown, so another
    // person's key of the same name is not this one.
    const app = o.tool && !o.tool.server ? o.tool.name : '';
    if (app === 'api_request' || app === 'credential_request') {
      const key = typeof o.input.key === 'string' ? o.input.key.trim().toLowerCase() : '';
      const trap = traps.find((x) => mine(x) && x.name === key);
      if (trap) return { wire: 'key', keyName: trap.name };
    }
    // An API source sends its own key; naming the source reaches it.
    if (app === 'api_call' && typeof o.input.api === 'string') {
      const source = (await this.services.apiSources.forBot(o.bot.id)).find((x) => x.name === o.input.api);
      const trap = source?.credential
        ? traps.find((x) => mine(x) && x.name === source.credential?.trim().toLowerCase())
        : undefined;
      if (trap) return { wire: 'key', keyName: trap.name };
    }
    // Anything that goes to a trap key's address, whichever way (a command, a page, a request).
    // A command on the bot's desktop is a shell command like any other.
    const shell = o.toolName === 'mcp__yumakbot__run_command';
    const reach = shell
      ? reachesOut('Bash', { command: o.input.command })
      : reachesOut(o.toolName, o.input, o.tool);
    if (o.toolName === 'SandboxNetworkAccess' || reach) {
      const text = strings(o.input).flatMap((s) => [s, decoded(s)]);
      for (const trap of traps) {
        const host = new URL(trap.origin).hostname;
        if (text.some((s) => s.toLowerCase().includes(host))) return { wire: 'key', keyName: trap.name };
      }
    }
    return null;
  }

  /**
   * What to do once a wire trips, apart from stopping the turn (the turn manager does that): move
   * the bot to "Ask" if it was freer, write the alarm down, say it in the conversation and tell
   * the person. Nothing here holds the input that tripped it.
   */
  async trip(o: {
    bot: Bot;
    thread: { id: string };
    turnId: string | null;
    /** Whose turn it was. */
    person: string;
    hit: CanaryHit;
    /** The tool that was refused, or `reply`. */
    tool: string;
    /** What the turn had read from outside before this. */
    sources: string[];
    t: T;
  }): Promise<CanaryAlarm> {
    const { bots, threads } = this.services;
    const { bot, hit, t } = o;
    // Only ever stricter: a bot on "Read only" stays there.
    const level = (await bots.get(bot.id).catch(() => bot)).permissionMode;
    const moved = STRICTNESS[level] > STRICTNESS.ask;
    if (moved) await bots.update(bot.id, { permissionMode: 'ask' });
    const [row] = await this.ctx.db
      .insert(schema.canaryAlarms)
      .values({
        id: newId(),
        wire: hit.wire,
        botId: bot.id,
        threadId: o.thread.id,
        turnId: o.turnId,
        userId: o.person,
        tool: o.tool,
        keyName: hit.keyName ?? null,
        sources: o.sources.slice(0, MAX_SOURCES),
        movedFrom: moved ? level : null,
      })
      .returning();
    const reply = o.tool === 'reply';
    const what = reply ? t('turn.canaryWhatReply') : t('turn.canaryWhatCall', { tool: o.tool });
    const done = reply ? t('turn.canaryDoneReply') : t('turn.canaryDoneCall');
    const levelText = moved
      ? t('turn.canaryMoved', { bot: bot.name })
      : t('turn.canaryAlreadyAsk', { bot: bot.name });
    const sources = o.sources.length
      ? t('turn.canarySources', { sources: o.sources.join(', ') })
      : t('turn.canaryNoSources');
    const text =
      hit.wire === 'key'
        ? t('turn.canaryKey', { bot: bot.name, key: hit.keyName ?? '', done, level: levelText, sources })
        : t('turn.canaryPrompt', { bot: bot.name, what, done, level: levelText, sources });
    await threads.addMessage({
      threadId: o.thread.id,
      role: 'system',
      author: 'system',
      text,
      props: { kind: 'canary', alarmId: row!.id },
      turnId: o.turnId ?? undefined,
    });
    this.ctx.bus.notice({
      kind: 'needsYou',
      botId: bot.id,
      threadId: o.thread.id,
      text: t('turn.canaryNotice', { bot: bot.name }),
    });
    this.ctx.bus.refresh({ scope: 'info' });
    return toAlarm(row!, bot.name);
  }

  /** The alarms nobody has marked seen, newest first; only those of `userId`. */
  async open(userId: string): Promise<CanaryAlarm[]> {
    const rows = await this.ctx.db
      .select({ alarm: schema.canaryAlarms, botName: schema.bots.name })
      .from(schema.canaryAlarms)
      .innerJoin(schema.bots, eq(schema.bots.id, schema.canaryAlarms.botId))
      .where(and(eq(schema.canaryAlarms.userId, userId), isNull(schema.canaryAlarms.seenAt)))
      .orderBy(desc(schema.canaryAlarms.createdAt));
    return rows.map((r) => toAlarm(r.alarm, r.botName));
  }

  /** Marks one of `userId`'s alarms seen; anyone else's is not found. */
  async seen(id: string, userId: string): Promise<void> {
    const [row] = await this.ctx.db.select().from(schema.canaryAlarms).where(eq(schema.canaryAlarms.id, id));
    if (!row || row.userId !== userId) throw notFound('canaryAlarm');
    await this.ctx.db
      .update(schema.canaryAlarms)
      .set({ seenAt: new Date() })
      .where(eq(schema.canaryAlarms.id, id));
    this.ctx.bus.refresh({ scope: 'info' });
  }
}
