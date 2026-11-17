import type { Bot } from '@yumakbot/shared';
import { z } from 'zod';
import type { AppTool } from '../engine/types';
import type { T } from '../i18n';
import type { Services } from '../services';
import { mailText } from '../services/email';
import type { Define } from './index';

/**
 * The bot's inbox: mail that came to its address, read when the bot needs it (a sign-up code, a
 * reply it waits for). What a mail says is outside data, whoever it claims to be from.
 */
export function emailTools(opts: {
  def: Define;
  services: Services;
  bot: Bot;
  address: string;
  t: T;
}): AppTool[] {
  const { def, services: s, bot, address, t } = opts;
  const labels = {
    from: t('email.from'),
    to: t('email.to'),
    subject: t('email.subject'),
    date: t('email.date'),
    files: t('email.files'),
  };
  return [
    def(
      'email_inbox',
      { unread: z.boolean().optional(), limit: z.number().int().min(1).max(50).optional() },
      async ({ unread, limit }) => {
        const mails = await s.email.inbox(bot.id, { unread, limit });
        if (!mails.length) return t(unread ? 'tool.emailNoneUnread' : 'tool.emailNone', { address });
        const lines = mails.map(
          (m) =>
            `- ${m.id} · ${m.receivedAt} · ${m.fromName ? `${m.fromName} <${m.from}>` : m.from} · ${m.subject || t('email.noSubject')}${m.readAt ? '' : ` · ${t('email.unread')}`}${m.attachments.length ? ` · 📎${m.attachments.length}` : ''}`,
        );
        return `${t('tool.emailInboxHead', { address })}\n${lines.join('\n')}`;
      },
      'read',
    ),
    def(
      'email_read',
      { id: z.string().min(1).max(64) },
      async ({ id }) => {
        const mail = await s.email.read(bot.id, id);
        return mail ? mailText(mail, labels) : t('tool.emailMissing');
      },
      'read',
    ),
  ];
}
