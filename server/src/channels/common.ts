import { outsideTrigger, questionItems, type Approval, type Message } from '@yumakbot/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import type { T } from '../i18n';
import type { Services } from '../services';
import { truncate } from '../util';

/** A chat app a message can come from; kept on the person's message as `via`. */
export type Via = 'telegram' | 'whatsapp';

/** One choice under a card; `data` is what comes back when it is pressed or typed. */
export interface CardButton {
  label: string;
  data: string;
}

/**
 * A card as a chat app shows it: its text (Markdown), and the choices that answer it there. A card
 * only the app can answer (a sign-in, a secret, several questions at once) has no choices and says
 * so; its text never holds what the person would type into it.
 */
export function cardView(
  a: Approval,
  props: Record<string, unknown>,
  t: T,
): { text: string; buttons: CardButton[] } {
  if (a.kind === 'tool') {
    const reason =
      typeof props.reviewReason === 'string' && props.reviewReason ? `\n_${props.reviewReason}_` : '';
    // A run outside text started takes no "always allow": the step was the text's choice.
    const outside = outsideTrigger(props.outside);
    const why = outside ? `\n_${t(`channel.outside.${outside}`)}_` : '';
    const always = !props.askRule && !props.heldBy && !outside;
    return {
      text: `🔐 ${a.summary}${why}${reason}`,
      buttons: [
        { label: t('channel.allow'), data: `a:${a.id}:y` },
        ...(always ? [{ label: t('channel.always'), data: `a:${a.id}:r` }] : []),
        { label: t('channel.deny'), data: `a:${a.id}:n` },
      ],
    };
  }
  if (a.kind === 'question') {
    const { title, items } = questionItems(a);
    const [q] = items;
    if (items.length === 1 && q && !q.secret) {
      const head = title ? `**${title}**\n` : '';
      const context = q.context ? `\n${q.context}` : '';
      const hint = `\n\n_${t(q.options.length ? 'channel.orType' : 'channel.typeAnswer')}_`;
      return {
        text: `❓ ${head}${q.question}${context}${hint}`,
        buttons: q.options.slice(0, 10).map((o, i) => ({ label: truncate(o, 60), data: `q:${a.id}:${i}` })),
      };
    }
  }
  return { text: `🔑 ${a.summary}\n\n${t('channel.inApp')}`, buttons: [] };
}

/** The answer a pressed choice gives, or null when the data is not one of ours. */
export function parseChoice(data: string): { approvalId: string; kind: 'a' | 'q'; value: string } | null {
  const m = /^([aq]):([^:]+):(\w+)$/.exec(data);
  return m ? { kind: m[1] as 'a' | 'q', approvalId: m[2]!, value: m[3]! } : null;
}

/** Whether the person last wrote to this conversation from that chat app; its replies go back there. */
export async function lastWroteVia(ctx: Ctx, threadId: string, via: Via): Promise<boolean> {
  const [last] = await ctx.db
    .select({ props: schema.messages.props })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.threadId, threadId),
        eq(schema.messages.role, 'user'),
        eq(schema.messages.author, 'user'),
      ),
    )
    .orderBy(desc(schema.messages.createdAt))
    .limit(1);
  return (last?.props as { via?: unknown } | undefined)?.via === via;
}

/** Runs the sends of one chat in order, one at a time, so a reply never overtakes its file. */
export class SendQueue {
  private tails = new Map<string, Promise<void>>();

  run(key: string, job: () => Promise<void>): Promise<void> {
    const next = (this.tails.get(key) ?? Promise.resolve())
      .then(job)
      .catch((err: unknown) => console.warn('chat app send', err));
    this.tails.set(key, next);
    void next.finally(() => {
      if (this.tails.get(key) === next) this.tails.delete(key);
    });
    return next;
  }

  async drain() {
    await Promise.all(this.tails.values());
  }
}

/** A name for a file that came without one: the kind of file and its message. */
export function receivedName(kind: string, id: string, mime?: string, name?: string): string {
  if (name) return name;
  const ext =
    {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'audio/ogg': 'ogg',
      'audio/mpeg': 'mp3',
      'audio/mp4': 'm4a',
      'video/mp4': 'mp4',
      'application/pdf': 'pdf',
    }[mime?.split(';')[0]?.trim() ?? ''] ??
    { photo: 'jpg', voice: 'ogg', video: 'mp4', video_note: 'mp4', animation: 'mp4', audio: 'mp3' }[kind] ??
    'bin';
  return `${kind}-${id}.${ext}`;
}

/** The files a bot's message carries, where they are on disk. */
export function messageFiles(m: Message): { name: string; size: number; path: string }[] {
  return Array.isArray(m.props.files)
    ? (m.props.files as { name: string; size: number; path: string }[])
    : [];
}

/**
 * `/stop` and `/new` typed in a chat app: what they did, in a line to send back; null when the
 * text is not one of them (it then goes to the bot as written).
 */
export async function chatCommand(
  services: Services,
  threadId: string,
  text: string,
  t: T,
): Promise<string | null> {
  const command = /^\/(stop|new)(?:@\w+)?\s*$/i.exec(text.trim())?.[1]?.toLowerCase();
  if (command === 'stop') {
    const stopped = await services.turns.interrupt(threadId);
    const teammates = await services.jobs.stopFrom(threadId);
    return t(stopped || teammates ? 'channel.stopped' : 'channel.nothingToStop');
  }
  if (command === 'new') {
    if ((await services.threads.state(threadId)) !== 'idle') return t('channel.busy');
    await services.threads.resetContext(threadId, t);
    return t('channel.newChat');
  }
  return null;
}

/** The kind of file a name says it is, for chat apps that want one. */
export function mimeOf(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return (
    {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      webp: 'image/webp',
      pdf: 'application/pdf',
      txt: 'text/plain',
      md: 'text/markdown',
      csv: 'text/csv',
      json: 'application/json',
      html: 'text/html',
      zip: 'application/zip',
      mp3: 'audio/mpeg',
      ogg: 'audio/ogg',
      m4a: 'audio/mp4',
      mp4: 'video/mp4',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    }[ext] ?? 'application/octet-stream'
  );
}
