import { stat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { PhoneNumber, type Bot, type WhatsAppGroup } from '@yumakbot/shared';
import type { ChatReads } from '../channels/whatsapp';
import { z } from 'zod';
import { schema } from '../db';
import type { AppTool } from '../engine/types';
import type { T } from '../i18n';
import type { Services } from '../services';
import { newId } from '../util';
import { realPath } from '../workspace';
import type { Define } from './index';

/**
 * WhatsApp for a bot working for the person who linked it, used in a conversation like any
 * connected app: the chats kept here (30 days) and drafts. Once the person lets the bots read
 * their chats, every chat is kept and seen; until then only the chats the bot's routines read, and
 * the first look asks the person on a card. A draft (a message, a Status post) goes to the person
 * on a card and nothing is sent until they answer "send"; the card is kept, so it works whenever
 * they answer, and the bot does not wait for it.
 */
export function whatsappTools(opts: {
  def: Define;
  services: Services;
  bot: Bot;
  /** Whom the turn works for: the person who linked WhatsApp. */
  person: string;
  /** The folders the bot's files may come from, and the one a relative name is read in. */
  roots: string[];
  cwd: string;
  /** Whether the bot may draft at all: a read-only bot only reads. */
  drafts: boolean;
  /** Whether a routine of the bot reads WhatsApp: it sees those chats without the bots reading all. */
  reader: boolean;
  /**
   * Whether the person asked for this work (their message, or a routine they saved): only then
   * may the bot reach chats beyond its routines', or ask to.
   */
  asked: () => Promise<boolean>;
  /** The chat whose reply started this turn, if one did: the turn reaches it too. */
  woken: () => Promise<string | null>;
  /** Asks the person on a card whether the bots may read every chat. */
  askOpen: () => Promise<'yes' | 'no' | 'timeout'>;
  t: T;
}): AppTool[] {
  const { def, services: s, bot, person, roots, cwd, t } = opts;
  const wa = s.whatsapp;
  const every: ChatReads = { groups: new Set(), people: true, all: true };
  /** The chats the bot sees: all of them once the person allowed it, else its routines'; null for none. */
  const reach = async (): Promise<ChatReads | null> => {
    if ((await wa.chatsOpen()) && (await opts.asked())) return every;
    const own = opts.reader ? await s.routines.whatsappReadsOf(bot.id) : null;
    const woke = await opts.woken();
    if (!woke) return own;
    return { groups: own?.groups ?? new Set(), people: own?.people ?? false, chats: new Set([woke]) };
  };
  /**
   * The chats the bot sees, or the person is asked first; a string is what the tool answers when
   * they did not allow it. A bot whose routines read some chats asks only once it needs others.
   */
  const reachOrAsk = async (others = false): Promise<ChatReads | string> => {
    const r = await reach();
    if (r && (r.all || !others)) return r;
    if (!(await opts.asked())) return r ?? t('tool.whatsappNotAsked');
    const answer = await opts.askOpen();
    if (answer === 'timeout') return t('tool.questionTimedOut');
    if (answer !== 'yes') return r ?? t('tool.whatsappOpenSkipped');
    await wa.openChats(true);
    return every;
  };

  /** A file the bot names, when it is inside one of its own folders. */
  const ownFile = async (name: string): Promise<string | null> => {
    const full = realPath(isAbsolute(name) ? name : resolve(cwd, name));
    if (!roots.some((r) => full.startsWith(realPath(r) + sep))) return null;
    const info = await stat(full).catch(() => null);
    return info?.isFile() ? full : null;
  };

  /** Puts a draft on a card in the bot's conversation with the person, and keeps it. */
  const draft = async (d: {
    kind: 'message' | 'status';
    chat: string | null;
    text: string;
    file: string | null;
    summary: string;
    approve: string;
    reject: string;
  }) => {
    const thread = await s.threads.main(bot.id, person);
    let made!: () => void;
    const created = new Promise<void>((done) => (made = done));
    const id = newId();
    const asked = s.approvals.ask({
      threadId: thread.id,
      botId: bot.id,
      turnId: null,
      kind: 'question',
      toolName: d.kind === 'status' ? 'whatsapp_status' : 'whatsapp_send',
      input: { chat: d.chat, text: d.text, file: d.file },
      summary: d.summary,
      options: [d.approve, d.reject],
      onCreated: async (ap) => {
        await s.ctx.db.insert(schema.whatsappDrafts).values({
          id,
          approvalId: ap.id,
          botId: bot.id,
          threadId: thread.id,
          kind: d.kind,
          chat: d.chat,
          text: d.text,
          file: d.file,
          approve: d.approve,
        });
        await s.threads.addMessage({
          threadId: thread.id,
          role: 'approval',
          author: `bot:${bot.id}`,
          text: ap.summary,
          props: { approvalId: ap.id },
        });
        made();
      },
    });
    // The answer is handled by the channel when it comes, not by this turn.
    void asked.catch((err: unknown) => console.warn('whatsapp draft card', err));
    await Promise.race([created, asked.then(() => undefined)]);
    return t('tool.whatsappDrafted');
  };

  const reads: AppTool[] = [
    def(
      'whatsapp_chats',
      { limit: z.number().int().min(1).max(100).default(30) },
      async ({ limit }) => {
        const r = await reachOrAsk();
        if (typeof r === 'string') return r;
        const rows = await wa.chats(limit, r);
        if (!rows.length) return t(r.all ? 'tool.whatsappNoChatsYet' : 'tool.whatsappNoChats');
        return rows
          .map((r) => `- ${r.jid} · ${r.kind} · ${r.name || '-'} · ${r.lastAt.toISOString()}`)
          .join('\n');
      },
      'read',
    ),
    def(
      'whatsapp_history',
      { chat: z.string().min(3).max(120), limit: z.number().int().min(1).max(200).default(50) },
      async ({ chat, limit }) => {
        let r = await reachOrAsk();
        if (typeof r === 'string') return r;
        // A chat the bot's routines do not read: the person may let it see every chat.
        if (!r.all && !(await wa.knownChat(chat, r)) && (await wa.knownChat(chat))) {
          r = await reachOrAsk(true);
          if (typeof r === 'string') return r;
        }
        return (
          (await wa.history(chat, limit, bot.id, r)) ??
          t(r.all ? 'tool.whatsappUnknownChatOpen' : 'tool.whatsappUnknownChat', { chat })
        );
      },
      'read',
    ),
  ];
  const tools: AppTool[] = [...reads];
  if (!opts.drafts) return tools;
  tools.push(
    def(
      'whatsapp_send',
      {
        chat: z.string().min(3).max(120),
        text: z.string().max(4000).default(''),
        file: z.string().max(1000).optional(),
      },
      async ({ chat: ref, text, file }) => {
        let r = await reachOrAsk();
        if (typeof r === 'string') return r;
        let chat = ref.trim();
        let known = await wa.knownChat(chat, r);
        // A number, or a chat the bot's routines do not read: the person may let it reach every chat.
        const phone = PhoneNumber.safeParse(chat);
        if (!known && !r.all && (phone.success || (await wa.knownChat(chat)))) {
          r = await reachOrAsk(true);
          if (typeof r === 'string') return r;
          known = await wa.knownChat(chat, r);
        }
        if (!known && r.all && phone.success) {
          const asChat = `${phone.data}@s.whatsapp.net`;
          known = await wa.knownChat(asChat, r);
          if (known) chat = asChat;
          else {
            // Someone who never wrote: only a number that is on WhatsApp. When that cannot be
            // checked now, the draft waits for the connection like any other.
            const found = await wa.numberChat(phone.data);
            if (found === null) return t('tool.whatsappNotOnWhatsApp', { phone: phone.data });
            chat = asChat;
            known = { name: '', kind: 'person' };
          }
        }
        if (!known) return t(r.all ? 'tool.whatsappUnknownChatOpen' : 'tool.whatsappUnknownChat', { chat });
        // Groups are only read.
        if (known.kind === 'group') return t('tool.whatsappNoGroupReply');
        const path = file ? await ownFile(file) : null;
        if (file && !path) return t('tool.whatsappBadFile', { file });
        if (!text.trim() && !path) return t('tool.whatsappEmpty');
        const number = chat.replace(/@.*$/, '');
        const to = known.name ? `${known.name} (${number})` : `+${number}`;
        const summary = [
          t('whatsapp.draftCard', { to, text: text.trim() }),
          ...(path ? ['', t('whatsapp.draftCardFile', { name: basename(path) })] : []),
        ].join('\n');
        return draft({
          kind: 'message',
          chat,
          text: text.trim(),
          file: path,
          summary,
          approve: t('whatsapp.send'),
          reject: t('whatsapp.dontSend'),
        });
      },
      'internal',
    ),
  );
  // A Status post reads no chat: any of the person's bots (a social one) may draft one.
  tools.push(
    def(
      'whatsapp_status',
      { text: z.string().max(700).default(''), file: z.string().max(1000).optional() },
      async ({ text, file }) => {
        const path = file ? await ownFile(file) : null;
        if (file && !path) return t('tool.whatsappBadFile', { file });
        if (!text.trim() && !path) return t('tool.whatsappEmpty');
        const count = (await wa.statusAudience()).length;
        if (!count) return t('tool.whatsappNoAudience');
        const summary = [
          t('whatsapp.statusCard', { count, text: text.trim() }),
          ...(path ? ['', t('whatsapp.draftCardFile', { name: basename(path) })] : []),
        ].join('\n');
        return draft({
          kind: 'status',
          chat: null,
          text: text.trim(),
          file: path,
          summary,
          approve: t('whatsapp.post'),
          reject: t('whatsapp.dontPost'),
        });
      },
      'internal',
    ),
  );
  return tools;
}

/** The folders a bot's files for WhatsApp may come from: its own, and its project's. */
export function whatsappRoots(dataDir: string, bot: Bot): string[] {
  return [join(resolve(dataDir, 'workspaces'), 'bots', bot.id), ...(bot.projectDir ? [bot.projectDir] : [])];
}

/**
 * The group a bot names, by its address or its name: an exact name first (case and accents as
 * WhatsApp keeps them aside), else the one name that contains it. `many` lists the names when more
 * than one fits; null when none does.
 */
export function pickGroup(
  groups: WhatsAppGroup[],
  ref: string,
): { group: WhatsAppGroup } | { many: string[] } | null {
  const fold = (x: string) => x.normalize('NFKC').toLocaleLowerCase('tr').replace(/\s+/g, ' ').trim();
  const wanted = fold(ref);
  if (!wanted) return null;
  const byId = groups.find((g) => g.id === ref.trim());
  if (byId) return { group: byId };
  const exact = groups.filter((g) => fold(g.name) === wanted);
  const hits = exact.length ? exact : groups.filter((g) => fold(g.name).includes(wanted));
  if (hits.length === 1) return { group: hits[0]! };
  return hits.length ? { many: hits.map((g) => g.name) } : null;
}
