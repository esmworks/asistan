import { join, relative, resolve } from 'node:path';
import { quoteExcerpt, titleFrom, type Message, type MessageFile, type ReplyQuote } from '@yumakbot/shared';
import type { Ctx } from '../context';
import { attachedFiles, moveIntoThread, promptWithFiles, promptWithReply, stagingDir } from '../uploads';
import { HttpError, isStopRequest, truncate } from '../util';
import { workspacePaths } from '../workspace';
import type { Services } from './index';

/** How much of the answered message goes into the bot's prompt. */
const MAX_QUOTED = 2000;

const fileNames = (m: Message) =>
  Array.isArray(m.props.files) ? (m.props.files as MessageFile[]).map((f) => f.name).join(', ') : '';

/** What a reply keeps of the message it answers, for the page to show above it. */
export const replyQuote = (m: Message): ReplyQuote => ({
  id: m.id,
  text: quoteExcerpt(m.text || fileNames(m)),
});

/**
 * What the person writes to a bot, from the app or from a chat app: the one path a message takes
 * into a conversation, so a stop word, an answer to a waiting card and a queued message behave the
 * same wherever it was typed.
 */
export class Inbox {
  constructor(
    private ctx: Ctx,
    private services: Services,
  ) {}

  /** The conversation folder of a bot's thread. */
  threadDir(bot: { id: string; groupId: string | null }, threadId: string) {
    return workspacePaths(this.ctx.config.dataDir, bot.id, threadId, bot.groupId).threadDir;
  }

  /** The prompt a person's message becomes: the quoted message first, the attached files after. */
  async prompt(text: string, dir: string, files: { name: string }[], answered?: Message) {
    const t = await this.services.settings.translator();
    const quoted = answered ? truncate(answered.text || fileNames(answered), MAX_QUOTED) : undefined;
    return promptWithFiles(promptWithReply(text, quoted, t), dir, files, t);
  }

  /**
   * Adds the person's message to a bot's conversation and starts the bot on it. `files` are names
   * waiting in the conversation's staging folder; they move into the conversation folder.
   * `created` is false for a repeat of a message already sent (the same `clientId`).
   */
  async send(
    threadId: string,
    input: {
      text: string;
      files?: string[];
      clientId?: string;
      replyTo?: string;
      /** Kept on the message, e.g. which chat app it came from. */
      props?: Record<string, unknown>;
    },
  ): Promise<{ message: Message; created: boolean }> {
    const s = this.services;
    const thread = await s.threads.row(threadId);
    const bot = await s.bots.get(thread.botId);
    if (bot.archivedAt) throw new HttpError(409, 'error.botArchived');
    // A repeat of a message already sent: its files have moved on, so answer with it as it is.
    const earlier = input.clientId ? await s.threads.byClientId(threadId, input.clientId) : null;
    if (earlier) return { message: earlier, created: false };
    // The message answered must be in this conversation; its text is read here, not taken from the page.
    const answered = input.replyTo ? await s.threads.message(input.replyTo) : undefined;
    if (answered && answered.threadId !== threadId) throw new HttpError(404, 'error.notFound.message');
    const dir = this.threadDir(bot, threadId);
    const staging = stagingDir(this.ctx.config.dataDir, threadId);
    const staged = attachedFiles(staging, input.files ?? []);
    const root = resolve(this.ctx.config.dataDir, 'workspaces');
    const files = (await moveIntoThread(staging, dir, staged)).map((f) => ({
      ...f,
      path: relative(root, join(dir, f.name)),
    }));
    const extra = input.props ?? {};
    const plain = {
      threadId,
      role: 'user' as const,
      author: 'user',
      text: input.text,
      clientId: input.clientId,
    };
    // Sent while the bot is busy: it waits its turn, and until then the person may change it.
    const queued = (await s.threads.state(threadId)) !== 'idle';
    const bare = queued && !files.length && !answered;
    // A bare "stop" while it works stops it, as the Stop button does, instead of waiting behind it.
    if (bare && isStopRequest(input.text)) {
      const { message } = await s.threads.addMessage({ ...plain, props: extra });
      await s.turns.interrupt(threadId);
      await s.jobs.stopFrom(threadId);
      return { message, created: true };
    }
    // Typed while the bot waits on its one-question card: the words are the answer to it.
    const card = bare ? await s.approvals.typedAnswerable(threadId) : null;
    if (card) {
      const { message } = await s.threads.addMessage({ ...plain, props: extra });
      await s.approvals.answer(card.id, { decision: 'allow', answer: input.text, remember: false });
      return { message, created: true };
    }
    // Typed while the bot waits on a step or sign-in card: the person chose to say something else
    // instead of pressing a button. The cards give way and the bot goes on with their words.
    const waiting = bare ? await s.approvals.redirectable(threadId) : [];
    if (waiting.length) {
      const { message } = await s.threads.addMessage({ ...plain, props: extra });
      for (const c of waiting) await s.approvals.redirect(c.id, input.text);
      return { message, created: true };
    }
    const { message, created } = await s.threads.addMessage({
      ...plain,
      props: {
        ...extra,
        ...(files.length ? { files } : {}),
        ...(answered ? { replyTo: replyQuote(answered) } : {}),
        ...(queued ? { queued: true } : {}),
      },
    });
    if (!created) return { message, created };
    // A conversation is named after the words its first message opens with.
    if (!thread.title) await s.threads.rename(threadId, titleFrom(input.text) || files[0]!.name.slice(0, 60));
    const prompt = await this.prompt(input.text, dir, files, answered);
    const turn = await s.turns.enqueue({ threadId, botId: bot.id, source: 'user', prompt });
    await s.threads.updateMessage(message.id, { turnId: turn.id });
    return { message: { ...message, turnId: turn.id }, created };
  }
}
