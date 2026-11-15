import type { Ctx } from '../context';
import { SILENT_REPLY } from '../engine/types';
import { reactionPrompt } from '../uploads';
import { truncate } from '../util';
import type { Services } from '.';

/** How much of the message reacted to goes into the bot's prompt. */
const MAX_QUOTED = 2000;

/**
 * Tells a bot about the person's emoji on one of its messages, in a turn of its own where it may
 * answer or stay quiet. The emoji has to stay put for a moment first, so trying a few in a row
 * tells the bot once, about the last one.
 */
export class ReactionNotifier {
  private timers = new Map<string, NodeJS.Timeout>();
  private telling = new Set<Promise<void>>();

  constructor(
    private ctx: Ctx,
    private services: Services,
  ) {}

  changed(messageId: string) {
    clearTimeout(this.timers.get(messageId));
    const timer = setTimeout(() => {
      this.timers.delete(messageId);
      const p = this.tell(messageId)
        .catch((err) => console.error('reaction', err))
        .finally(() => this.telling.delete(p));
      this.telling.add(p);
    }, this.ctx.config.reactionDelayMs);
    timer.unref?.();
    this.timers.set(messageId, timer);
  }

  /** Drops reactions still settling and waits for the ones being passed on. */
  async stop() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.allSettled([...this.telling]);
  }

  private async tell(messageId: string) {
    const { threads, bots, settings, turns } = this.services;
    const m = await threads.message(messageId);
    const emoji = typeof m.props.userReaction === 'string' ? m.props.userReaction : null;
    // Taking an emoji off, or putting back the one the bot already heard of, tells it nothing new.
    if (!emoji || emoji === m.props.reactionTold) return;
    const thread = await threads.row(m.threadId);
    const bot = await bots.get(thread.botId);
    if (bot.archivedAt) return;
    await threads.mergeProps(messageId, { reactionTold: emoji });
    const t = await settings.translator();
    await turns.enqueue({
      threadId: thread.id,
      botId: bot.id,
      source: 'reaction',
      prompt: reactionPrompt(emoji, truncate(m.text, MAX_QUOTED), t, SILENT_REPLY),
    });
  }
}
