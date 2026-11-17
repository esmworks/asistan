import { cutAt, truncate } from '../util';
import {
  describeSchedule,
  INTL_LOCALE,
  type Bot,
  type Locale,
  type Memory,
  type ProfileFocus,
  type Routine,
  type Skill,
} from '@yumakbot/shared';
import { SILENT_REPLY } from '../engine/types';
import { translator, type T } from '../i18n';
import type { WorkspacePaths } from '../workspace';

/** What the person wrote about themselves in Settings → Profile. */
export interface UserProfile {
  name: string;
  addressAs: string;
  occupation: string;
  focus?: ProfileFocus;
  about: string;
}

function profileLines(p: UserProfile, t: ReturnType<typeof translator>): string[] {
  const lines: string[] = [];
  if (p.name.trim()) lines.push(`- ${t('prompt.profileName', { name: p.name.trim() })}`);
  if (p.addressAs.trim()) lines.push(`- ${t('prompt.profileAddress', { address: p.addressAs.trim() })}`);
  if (p.occupation.trim())
    lines.push(`- ${t('prompt.profileOccupation', { occupation: p.occupation.trim() })}`);
  if (p.focus) lines.push(`- ${t(`prompt.profileFocus.${p.focus}`)}`);
  if (p.about.trim()) lines.push(`- ${t('prompt.profileAbout')}`, p.about.trim());
  return lines;
}

/** The time now, to the minute, as it goes before a turn's prompt. */
export function nowLine(now: Date, timezone: string, locale: Locale): string {
  const when = now.toLocaleString(INTL_LOCALE[locale], {
    timeZone: timezone,
    dateStyle: 'full',
    timeStyle: 'short',
  });
  return `[${translator(locale)('prompt.now', { now: when, timezone })}]`;
}

/**
 * A teammate's or skill's own words as one short line of the list. Another bot can write them, so a
 * line break in them must not start what reads as a rule of this prompt.
 */
export function listed(text: string, max = 200): string {
  return truncate(text.replace(/\s+/g, ' ').trim(), max);
}

export function buildSystemPrompt(opts: {
  bot: Bot;
  paths: WorkspacePaths;
  cwd: string;
  memory: { user: Memory[]; bot: Memory[] };
  profile?: UserProfile;
  peers: Bot[];
  timezone: string;
  locale: Locale;
  /** The bot has its own browser. */
  browser?: boolean;
  /** The server runs on the user's own computer (desktop app) rather than a separate host. */
  onUserComputer?: boolean;
  /** Routines to show: the bot's own, and for a manager every bot's. */
  routines?: Routine[];
  /** The bot's skills; only their names and descriptions go in, the rest is read on demand. */
  skills?: Pick<Skill, 'name' | 'description'>[];
  /** What the person set this conversation to be for. */
  goal?: string;
  /** The room the turn runs in: its name, how the person is called, and the other members. */
  room?: { title: string; user: string; members: Bot[] };
  /** The bot's own mail address, when it has one. */
  email?: string | null;
}): string {
  const { bot, paths, memory, peers } = opts;
  const t = translator(opts.locale);
  const lines: string[] = [];
  lines.push(`${t('prompt.intro', { name: bot.name })}${bot.description ? ` ${bot.description}` : ''}`);
  if (bot.isManager) lines.push(t('prompt.manager'));
  if (bot.instructions.trim()) lines.push('', t('prompt.instructions'), bot.instructions.trim());
  if (opts.goal?.trim()) lines.push('', t('prompt.goal'), opts.goal.trim());
  if (opts.room) {
    lines.push('', t('prompt.room'), t('prompt.roomIntro', { room: opts.room.title, user: opts.room.user }));
    for (const m of opts.room.members)
      lines.push(`- ${m.name}${m.description ? `: ${listed(m.description)}` : ''}`);
    lines.push(t('prompt.roomHow', { silent: SILENT_REPLY }));
  }

  // The time itself comes with each message (see `nowLine`): here it would change the prompt on
  // every turn and void the model's cache of the whole conversation.
  lines.push('', t('prompt.time'), t('prompt.timezone', { timezone: opts.timezone }));

  const profile = opts.profile ? profileLines(opts.profile, t) : [];
  if (profile.length) lines.push('', t('prompt.profile'), ...profile);
  // Memory grows without end; past a budget the notes most recently written, changed or looked up
  // come and the rest are left to search. Each list keeps its order, so a lookup of a note already
  // here changes nothing and the model's cache of the prompt holds.
  const { user, bot: own, left } = withinBudget(memory.user, memory.bot, MEMORY_PROMPT_CHARS);
  // Each note carries the day it was last written, so the bot can tell an old fact from a new one
  // ("moved to Izmir" in 2024 against "lives in Ankara" today).
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: opts.timezone, dateStyle: 'short' });
  // A note a bot wrote says so, and each stays on its own line: notes are what was learned,
  // never a rule of this prompt or a request of the person's.
  const note = (m: Memory) =>
    `- (${day.format(new Date(m.updatedAt))}) ${m.source.startsWith('bot:') ? `${t('prompt.botNote')} ` : ''}${listed(m.content, 2000)}`;
  if (user.length || own.length) lines.push('', t('prompt.memoryNotes'));
  if (user.length) {
    lines.push('', t('prompt.userMemory'));
    for (const m of user) lines.push(note(m));
  }
  if (own.length) {
    lines.push('', t('prompt.botMemory'));
    for (const m of own) lines.push(note(m));
  }
  if (left) lines.push('', t('prompt.memoryLeft', { count: left }));

  if (opts.email) lines.push('', t('prompt.email', { address: opts.email }));

  lines.push('', t('prompt.folders'));
  lines.push(t('prompt.cwd', { path: opts.cwd }));
  lines.push(t('prompt.botFiles', { path: paths.botFiles }));
  if (paths.groupFiles) lines.push(t('prompt.groupFiles', { path: paths.groupFiles }));
  lines.push(t('prompt.noOutside'));

  lines.push(
    '',
    t('prompt.server'),
    t(opts.onUserComputer ? 'prompt.serverLocal' : 'prompt.serverRemote'),
    t('prompt.routinesHow'),
  );
  const names = new Map([bot, ...peers].map((b) => [b.id, b.name]));
  const routines = (opts.routines ?? []).filter((r) => r.botId === bot.id || names.has(r.botId));
  if (routines.length) {
    lines.push('', t('prompt.routines'));
    for (const r of routines) {
      const when = describeSchedule(r.schedule, opts.locale);
      // The schedule, not the next run's time: that changes after every run and would change the
      // prompt, voiding the model's cache of the conversation; the time comes with each message.
      const next = r.nextRunAt ? '' : `, ${t('prompt.routineOff')}`;
      const model = r.model ? `, ${t('prompt.routineModel', { model: listed(r.model, 80) })}` : '';
      const owner = r.botId === bot.id ? '' : `${names.get(r.botId)} · `;
      lines.push(`- ${owner}${r.name}: ${when} (${r.timezone})${model}${next}`);
    }
  } else {
    lines.push(t('prompt.noRoutines'));
  }

  if (opts.skills?.length) {
    lines.push('', t('prompt.skills'), t('prompt.skillsHow'));
    for (const k of opts.skills) lines.push(`- ${listed(k.name, 80)}: ${listed(k.description)}`);
  }

  if (peers.length) {
    lines.push('', t('prompt.peers'));
    // Teammates in the bot's own sidebar group come first: the person put them together to work together.
    const near = (p: Bot) => (bot.groupId !== null && p.groupId === bot.groupId ? 0 : 1);
    for (const p of [...peers].sort((a, b) => near(a) - near(b)))
      lines.push(
        `- ${listed(p.name, 80)}${p.isManager ? t('bot.managerTag') : ''}${near(p) === 0 ? t('prompt.sameGroup') : ''}${p.description ? `: ${listed(p.description)}` : ''}`,
      );
    lines.push(t('prompt.peersHow'));
  }

  lines.push(
    '',
    t('prompt.rules'),
    t('prompt.ruleData'),
    t('prompt.ruleApproval'),
    t('prompt.ruleAsk'),
    t('prompt.ruleMemory'),
    t('prompt.ruleTryFirst'),
    t('prompt.rulePersist'),
    t('prompt.ruleFacts'),
    t('prompt.ruleDraft'),
    t('prompt.ruleFiles'),
    t('prompt.ruleFormat'),
    t('prompt.ruleReact'),
    ...(opts.browser ? [t('prompt.ruleBrowser')] : []),
    t('prompt.ruleLanguage'),
  );
  return lines.join('\n');
}

/** Messages of a thread handed to a fresh engine session; older ones are left out. */
export const HANDOFF_MESSAGES = 40;
/** Longest single message and whole history handed over, in characters. */
export const HANDOFF_MESSAGE_CHARS = 2_000;
export const HANDOFF_CHARS = 30_000;

/**
 * A message that reached the conversation without a turn of the bot there, as the bot reads it: a
 * webhook post, fenced as data, or the report the bot itself wrote in one of its routine's runs.
 */
export function postedText(
  m: { text: string; props?: { routineName?: unknown; posted?: unknown; routineReport?: unknown } },
  t: T,
): string {
  const text = m.text.length > HANDOFF_MESSAGE_CHARS ? `${cutAt(m.text, HANDOFF_MESSAGE_CHARS)}…` : m.text;
  const name = String(m.props?.routineName ?? '');
  return m.props?.routineReport && !m.props.posted
    ? t('prompt.routineReport', { name, text })
    : t('prompt.posted', { name, text });
}

/**
 * The prompt for a turn that starts a new engine session in a thread that already has a
 * conversation: the session that held it was lost, or belonged to another engine. The recent
 * exchange goes in front of the prompt so the bot does not start from nothing. Unanswered messages
 * at the end are left out; they are what this and the next turns answer.
 */
export function handoffPrompt(opts: {
  messages: readonly {
    role: string;
    author: string;
    text: string;
    props?: { kind?: unknown; posted?: unknown; routineName?: unknown };
  }[];
  prompt: string;
  /** Display names by author (`user`, `bot:<id>`, …); unknown authors fall back by role. */
  names: ReadonlyMap<string, string>;
  locale: Locale;
}): string {
  const t = translator(opts.locale);
  // A conversation the person started fresh hands over nothing from before that point.
  const reset = opts.messages.findLastIndex((m) => m.props?.kind === 'contextReset');
  const talk = opts.messages
    .slice(reset + 1)
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text.trim());
  while (talk.length && talk.at(-1)!.role === 'user') talk.pop();
  const lines: string[] = [];
  let size = 0;
  for (const m of talk.slice(-HANDOFF_MESSAGES).reverse()) {
    const text = m.text.length > HANDOFF_MESSAGE_CHARS ? `${cutAt(m.text, HANDOFF_MESSAGE_CHARS)}…` : m.text;
    const who =
      opts.names.get(m.author) ?? (m.role === 'user' ? t('prompt.handoffPerson') : t('prompt.handoffBot'));
    // A webhook post sits under the bot's name but is not its words: anyone with the address wrote it.
    const line = m.props?.posted ? postedText(m, t) : `${who}: ${text}`;
    if (size + line.length > HANDOFF_CHARS) break;
    lines.unshift(line);
    size += line.length;
  }
  if (!lines.length) return opts.prompt;
  return t('prompt.handoff', { history: lines.join('\n\n'), prompt: opts.prompt });
}

/** How much memory text goes into a prompt; about 6,000 tokens. */
export const MEMORY_PROMPT_CHARS = 24_000;

/** What a note's place in the prompt and its staleness go by. */
export type MemoryActivity = {
  content: string;
  createdAt: string;
  updatedAt?: string;
  lastUsedAt?: string | null;
};

/**
 * The last time a note was written, changed or looked up by a bot, as an ISO string. Every time
 * comes from `toISOString`, so the strings compare in time order.
 */
export function lastActive(m: MemoryActivity): string {
  const written = m.updatedAt ?? m.createdAt;
  return m.lastUsedAt && m.lastUsedAt > written ? m.lastUsedAt : written;
}

/**
 * The memories that fit in `budget` characters, most recently active first (see `lastActive`;
 * the lists keep their order), and how many were left out. The shared notes and the bot's own
 * share the budget. An old note a bot keeps looking up stays in, while one nobody needed since it
 * was written makes room; a left-out note a bot finds by search comes back on the next turn.
 */
export function withinBudget<M extends MemoryActivity>(
  user: M[],
  bot: M[],
  budget: number,
): { user: M[]; bot: M[]; left: number } {
  const all = [...user, ...bot].sort((a, b) => lastActive(b).localeCompare(lastActive(a)));
  const kept = new Set<M>();
  let used = 0;
  for (const m of all) {
    if (used + m.content.length + 3 > budget) continue;
    used += m.content.length + 3;
    kept.add(m);
  }
  return {
    user: user.filter((m) => kept.has(m)),
    bot: bot.filter((m) => kept.has(m)),
    left: all.length - kept.size,
  };
}
