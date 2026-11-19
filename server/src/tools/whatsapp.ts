import { stat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import type { Bot, WhatsAppGroup } from '@yumakbot/shared';
import { z } from 'zod';
import { schema } from '../db';
import type { AppTool } from '../engine/types';
import type { T } from '../i18n';
import type { Services } from '../services';
import { newId } from '../util';
import { realPath } from '../workspace';
import type { Define } from './index';

/**
 * WhatsApp for a bot working for the person who linked it: the chats routines read, kept 30 days,
 * and drafts. A draft (a reply, a Status post) goes to the person on a card and nothing is sent
 * until they answer "send"; the card is kept, so it works whenever they answer, and the bot does
 * not wait for it.
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
  /** Whether a routine of the bot reads WhatsApp: only then does it see chats and answer them. */
  reader: boolean;
  t: T;
}): AppTool[] {
  const { def, services: s, bot, person, roots, cwd, t } = opts;
  const wa = s.whatsapp;
  /** The chats this bot's routines read: the only ones it sees and answers. */
  const covered = () => s.routines.whatsappReadsOf(bot.id);

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
        const rows = await wa.chats(limit, await covered());
        if (!rows.length) return t('tool.whatsappNoChats');
        return rows
          .map((r) => `- ${r.jid} · ${r.kind} · ${r.name || '-'} · ${r.lastAt.toISOString()}`)
          .join('\n');
      },
      'read',
    ),
    def(
      'whatsapp_history',
      { chat: z.string().min(3).max(120), limit: z.number().int().min(1).max(200).default(50) },
      async ({ chat, limit }) =>
        (await wa.history(chat, limit, bot.id, await covered())) ?? t('tool.whatsappUnknownChat', { chat }),
      'read',
    ),
  ];
  const tools: AppTool[] = opts.reader ? reads : [];
  if (!opts.drafts) return tools;
  if (opts.reader) {
    tools.push(
      def(
        'whatsapp_send',
        {
          chat: z.string().min(3).max(120),
          text: z.string().max(4000).default(''),
          file: z.string().max(1000).optional(),
        },
        async ({ chat, text, file }) => {
          const known = await wa.knownChat(chat, await covered());
          if (!known) return t('tool.whatsappUnknownChat', { chat });
          // Groups are only read.
          if (known.kind === 'group') return t('tool.whatsappNoGroupReply');
          const path = file ? await ownFile(file) : null;
          if (file && !path) return t('tool.whatsappBadFile', { file });
          if (!text.trim() && !path) return t('tool.whatsappEmpty');
          const to = known.name ? `${known.name} (${chat.replace(/@.*$/, '')})` : chat;
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
  }
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
