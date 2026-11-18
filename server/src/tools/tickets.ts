import { TICKET_PRIORITIES, TICKET_STATUSES, type Bot, type Ticket } from '@yumakbot/shared';
import { z } from 'zod';
import type { AppTool } from '../engine/types';
import type { T } from '../i18n';
import type { TurnRow } from '../runtime/turns';
import type { Services } from '../services';
import { truncate } from '../util';
import type { Define } from './index';

/**
 * The board, for bots: list tickets, open new ones (for itself, another bot or the person) and
 * update them with a status and a comment. A ticket a bot opens while working on a ticket waits
 * for the person instead of starting its assignee, so tickets cannot keep starting each other.
 */
export function ticketTools(opts: {
  def: Define;
  services: Services;
  bot: Bot;
  turn: TurnRow;
  t: T;
  /** A bot the turn's person may talk with, by name or id. */
  reach: (ref: string) => Promise<Bot>;
}): AppTool[] {
  const { def, services: s, bot, turn, t } = opts;
  const by = `bot:${bot.id}`;
  const start = turn.source !== 'ticket';
  const names = async () => new Map((await s.bots.list()).map((b) => [b.id, b.name]));
  const line = (k: Ticket, who: Map<string, string>) =>
    `- #${k.number} [${t(`ticket.status.${k.status}`)}] ${k.title} · ${t(`ticket.priority.${k.priority}`)}${k.assigneeBotId ? ` · ${who.get(k.assigneeBotId) ?? '?'}` : ''}`;
  const assignee = async (ref: string | undefined) => {
    if (ref === undefined) return undefined;
    if (!ref.trim()) return null;
    return (await opts.reach(ref)).id;
  };
  return [
    def(
      'tickets_list',
      { status: z.array(z.enum(TICKET_STATUSES)).optional(), mine: z.boolean().optional() },
      async ({ status, mine }) => {
        const list = await s.tickets.list({ status, assigneeBotId: mine ? bot.id : undefined });
        if (!list.length) return t('tool.ticketsNone');
        const who = await names();
        return list
          .slice(0, 50)
          .map((k) => line(k, who))
          .join('\n');
      },
      'read',
    ),
    def(
      'ticket_read',
      { ticket: z.union([z.string(), z.number()]) },
      async ({ ticket }) => {
        const k = await s.tickets.find(ticket);
        if (!k) return t('tool.ticketMissing', { ticket: String(ticket) });
        const who = await names();
        const author = (a: string) => (a === 'user' ? t('ticket.you') : (who.get(a.slice(4)) ?? a));
        return [
          line(k, who),
          '',
          k.description || t('ticket.noDescription'),
          ...(k.comments.length
            ? ['', ...k.comments.map((c) => `> ${author(c.author)}: ${truncate(c.text, 2000)}`)]
            : []),
        ].join('\n');
      },
      'read',
    ),
    def(
      'ticket_create',
      {
        title: z.string().trim().min(1).max(200),
        description: z.string().max(20_000).optional(),
        priority: z.enum(TICKET_PRIORITIES).optional(),
        assign_to: z.string().max(200).optional(),
      },
      async (a) => {
        const k = await s.tickets.create(
          {
            title: a.title,
            description: a.description ?? '',
            priority: a.priority ?? 'normal',
            assigneeBotId: (await assignee(a.assign_to)) ?? null,
          },
          by,
          start,
        );
        return t(start || !k.assigneeBotId ? 'tool.ticketCreated' : 'tool.ticketCreatedWaiting', {
          number: k.number,
        });
      },
      'internal',
    ),
    def(
      'ticket_update',
      {
        ticket: z.union([z.string(), z.number()]),
        status: z.enum(TICKET_STATUSES).optional(),
        comment: z.string().max(20_000).optional(),
        assign_to: z.string().max(200).optional(),
        priority: z.enum(TICKET_PRIORITIES).optional(),
        title: z.string().trim().min(1).max(200).optional(),
        description: z.string().max(20_000).optional(),
      },
      async (a) => {
        const k = await s.tickets.find(a.ticket);
        if (!k) return t('tool.ticketMissing', { ticket: String(a.ticket) });
        const assigneeBotId = await assignee(a.assign_to);
        await s.tickets.update(
          k.id,
          {
            ...(a.status && { status: a.status }),
            ...(a.priority && { priority: a.priority }),
            ...(a.title && { title: a.title }),
            ...(a.description !== undefined && { description: a.description }),
            ...(assigneeBotId !== undefined && { assigneeBotId }),
          },
          start,
        );
        if (a.comment?.trim()) await s.tickets.comment(k.id, a.comment.trim(), by);
        return t('tool.ticketUpdated', { number: k.number });
      },
      'internal',
    ),
  ];
}
