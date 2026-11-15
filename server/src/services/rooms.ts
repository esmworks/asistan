import {
  findMentions,
  type Bot,
  type Message,
  type Room,
  type RoomCreate,
  type RoomSend,
  type RoomUpdate,
} from '@yumakbot/shared';
import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import { isSilentReply, SILENT_REPLY, type TurnOutcome } from '../engine/types';
import type { T } from '../i18n';
import { HANDOFF_CHARS, HANDOFF_MESSAGE_CHARS } from '../runtime/prompt';
import type { TurnRow } from '../runtime/turns';
import { HttpError, newId, notFound, truncate } from '../util';
import type { Services } from '.';

type RoomRow = typeof schema.rooms.$inferSelect;
type MemberRow = typeof schema.roomMembers.$inferSelect;

/** Room lines a member is shown when it starts a new session there. */
export const ROOM_WINDOW = 30;
/** Turns bots may start for one another beyond the rounds, per message of the person. */
const MENTION_TURNS = 4;
/** Hard cap on the turns bots start for one another per message of the person. */
const MAX_BOT_TURNS = 40;

/**
 * Rooms: one thread where the person and several bots talk. Every member's turn runs in that one
 * thread, so only one speaks at a time and stopping the room stops them all. A message of the
 * person is answered by the members it names (or every member, as the room is set); a bot's
 * answer that names another member gives that one a turn; and the room may go on for a few rounds
 * of the bots talking among themselves. Each message of the person sets a fresh budget for that.
 */
export class RoomService {
  /** Where each running turn's prompt ended, saved as the member's place once the turn succeeds. */
  private cursors = new Map<string, Date>();

  constructor(
    private ctx: Ctx,
    private services: Services,
  ) {}

  private async roomRow(id: string): Promise<RoomRow | null> {
    const [row] = await this.ctx.db.select().from(schema.rooms).where(eq(schema.rooms.id, id)).limit(1);
    return row ?? null;
  }

  private async members(roomId: string): Promise<MemberRow[]> {
    return this.ctx.db
      .select()
      .from(schema.roomMembers)
      .where(eq(schema.roomMembers.roomId, roomId))
      .orderBy(asc(schema.roomMembers.position));
  }

  /** Members that can speak now, in speaking order. */
  private async activeBots(roomId: string): Promise<Bot[]> {
    const ids = (await this.members(roomId)).map((m) => m.botId);
    const bots = await this.services.bots.list();
    return ids.map((id) => bots.find((b) => b.id === id)).filter((b): b is Bot => !!b);
  }

  async isRoom(threadId: string): Promise<boolean> {
    return !!(await this.roomRow(threadId));
  }

  async list(): Promise<Room[]> {
    const rows = await this.ctx.db
      .select({ id: schema.threads.id })
      .from(schema.threads)
      .where(eq(schema.threads.kind, 'room'))
      .orderBy(desc(schema.threads.updatedAt));
    return Promise.all(rows.map((r) => this.get(r.id)));
  }

  async get(id: string): Promise<Room> {
    const room = await this.roomRow(id);
    if (!room) throw notFound('room');
    const thread = await this.services.threads.get(id);
    const members = await this.members(id);
    const [speaking] = await this.ctx.db
      .select({ botId: schema.turns.botId })
      .from(schema.turns)
      .where(and(eq(schema.turns.threadId, id), eq(schema.turns.status, 'running')))
      .limit(1);
    return {
      id,
      title: thread.title,
      goal: thread.goal ?? '',
      members: members.map((m) => m.botId),
      responders: room.responders,
      rounds: room.rounds,
      state: thread.state,
      speakerId: speaking?.botId ?? null,
      preview: thread.preview,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    };
  }

  /** The bots exactly as given, checked: each exists, is not archived, and comes once. */
  private async checkedBots(ids: string[]): Promise<string[]> {
    const unique = [...new Set(ids)];
    const bots = await this.services.bots.list();
    if (!unique.every((id) => bots.some((b) => b.id === id))) throw new HttpError(400, 'error.roomBots');
    return unique;
  }

  async create(input: RoomCreate): Promise<Room> {
    const botIds = await this.checkedBots(input.botIds);
    const id = newId();
    await this.ctx.db.insert(schema.threads).values({
      id,
      botId: botIds[0]!,
      kind: 'room',
      title: input.title,
      goal: input.goal ?? '',
    });
    await this.ctx.db.insert(schema.rooms).values({
      id,
      responders: input.responders ?? 'everyone',
      rounds: input.rounds ?? 0,
    });
    await this.ctx.db
      .insert(schema.roomMembers)
      .values(botIds.map((botId, position) => ({ roomId: id, botId, position })));
    this.ctx.bus.refresh({ scope: 'rooms' });
    return this.get(id);
  }

  async update(id: string, patch: RoomUpdate): Promise<Room> {
    if (!(await this.roomRow(id))) throw notFound('room');
    if (patch.title !== undefined || patch.goal !== undefined) {
      await this.ctx.db
        .update(schema.threads)
        .set({
          ...(patch.title !== undefined && { title: patch.title }),
          ...(patch.goal !== undefined && { goal: patch.goal }),
        })
        .where(eq(schema.threads.id, id));
    }
    if (patch.responders !== undefined || patch.rounds !== undefined) {
      await this.ctx.db
        .update(schema.rooms)
        .set({
          ...(patch.responders !== undefined && { responders: patch.responders }),
          ...(patch.rounds !== undefined && { rounds: patch.rounds }),
        })
        .where(eq(schema.rooms.id, id));
    }
    if (patch.botIds) await this.setMembers(id, await this.checkedBots(patch.botIds));
    this.ctx.bus.refresh({ scope: 'rooms' });
    return this.get(id);
  }

  /** New membership in this order; members that stay keep their session and place. */
  private async setMembers(id: string, botIds: string[]) {
    const now = await this.members(id);
    const gone = now.filter((m) => !botIds.includes(m.botId)).map((m) => m.botId);
    if (gone.length) {
      await this.ctx.db
        .delete(schema.roomMembers)
        .where(and(eq(schema.roomMembers.roomId, id), inArray(schema.roomMembers.botId, gone)));
    }
    for (const [position, botId] of botIds.entries()) {
      if (now.some((m) => m.botId === botId)) {
        await this.ctx.db
          .update(schema.roomMembers)
          .set({ position })
          .where(and(eq(schema.roomMembers.roomId, id), eq(schema.roomMembers.botId, botId)));
      } else {
        await this.ctx.db.insert(schema.roomMembers).values({ roomId: id, botId, position });
      }
    }
    await this.ctx.db.update(schema.threads).set({ botId: botIds[0]! }).where(eq(schema.threads.id, id));
  }

  async remove(id: string) {
    if (!(await this.roomRow(id))) throw notFound('room');
    await this.stop(id);
    await this.ctx.db.delete(schema.threads).where(eq(schema.threads.id, id));
    this.ctx.bus.refresh({ scope: 'rooms' });
  }

  /**
   * A bot about to be removed for good leaves its rooms first. The room's thread points at one
   * member, so it is moved to another; a room left with no one goes with the bot.
   */
  async removeBot(botId: string) {
    const rows = await this.ctx.db
      .select({ roomId: schema.roomMembers.roomId })
      .from(schema.roomMembers)
      .where(eq(schema.roomMembers.botId, botId));
    for (const { roomId } of rows) {
      const rest = (await this.members(roomId)).filter((m) => m.botId !== botId).map((m) => m.botId);
      if (rest.length) await this.setMembers(roomId, rest);
    }
    if (rows.length) this.ctx.bus.refresh({ scope: 'rooms' });
  }

  /** Stops whoever speaks, drops who waits, and ends the discussion under way. */
  async stop(id: string): Promise<boolean> {
    await this.ctx.db
      .update(schema.rooms)
      .set({ roundsLeft: 0, botTurnsLeft: 0 })
      .where(eq(schema.rooms.id, id));
    return this.services.turns.interrupt(id);
  }

  /** The member's engine session in the room, and what it had cost by its last run. */
  async session(roomId: string, botId: string): Promise<{ id: string | null; costUsd: number | null }> {
    const [m] = await this.ctx.db
      .select({ id: schema.roomMembers.engineSessionId, costUsd: schema.roomMembers.engineSessionCostUsd })
      .from(schema.roomMembers)
      .where(and(eq(schema.roomMembers.roomId, roomId), eq(schema.roomMembers.botId, botId)))
      .limit(1);
    return { id: m?.id ?? null, costUsd: m?.costUsd ?? null };
  }

  async setSessionCost(roomId: string, botId: string, costUsd: number) {
    await this.ctx.db
      .update(schema.roomMembers)
      .set({ engineSessionCostUsd: costUsd })
      .where(and(eq(schema.roomMembers.roomId, roomId), eq(schema.roomMembers.botId, botId)));
  }

  async setSession(roomId: string, botId: string, sessionId: string | null) {
    await this.ctx.db
      .update(schema.roomMembers)
      .set({ engineSessionId: sessionId, ...(sessionId === null && { engineSessionCostUsd: null }) })
      .where(and(eq(schema.roomMembers.roomId, roomId), eq(schema.roomMembers.botId, botId)));
  }

  /** What the system prompt says about the room to one of its members. */
  async context(roomId: string, bot: Bot, user: string, t: T) {
    const thread = await this.services.threads.row(roomId);
    const others = (await this.activeBots(roomId)).filter((b) => b.id !== bot.id);
    return { title: thread.title, user: user || t('room.person'), members: others };
  }

  /** The person writes in the room; the members it names (or as the room is set) answer in turn. */
  async post(roomId: string, body: RoomSend): Promise<{ message: Message; created: boolean }> {
    const room = await this.roomRow(roomId);
    if (!room) throw notFound('room');
    const { threads, turns } = this.services;
    const answered = body.replyTo ? await threads.message(body.replyTo) : undefined;
    if (answered && answered.threadId !== roomId) throw new HttpError(404, 'error.notFound.message');
    const result = await threads.addMessage({
      threadId: roomId,
      role: 'user',
      author: 'user',
      text: body.text,
      clientId: body.clientId,
      props: answered ? { replyTo: { id: answered.id, text: truncate(answered.text, 300) } } : {},
    });
    if (!result.created) return result;
    // The person speaking takes the floor: whoever still waits is dropped, and answers what is said
    // now instead, with everything since it last spoke in its prompt.
    await turns.dropQueued(roomId);
    const bots = await this.activeBots(roomId);
    const named = findMentions(body.text, bots);
    // A reply to a bot's message counts as naming that bot.
    const repliedTo = answered?.author.startsWith('bot:') ? answered.author.slice(4) : null;
    const ids = named.everyone
      ? bots.map((b) => b.id)
      : named.ids.length || repliedTo
        ? [...new Set([...named.ids, ...(repliedTo ? [repliedTo] : [])])]
        : room.responders === 'everyone'
          ? bots.map((b) => b.id)
          : [];
    const answering = ids.filter((id) => bots.some((b) => b.id === id));
    await this.ctx.db
      .update(schema.rooms)
      .set({
        roundsLeft: room.rounds,
        roundSpoke: false,
        botTurnsLeft: Math.min(MAX_BOT_TURNS, bots.length * room.rounds + MENTION_TURNS),
      })
      .where(eq(schema.rooms.id, roomId));
    for (const botId of answering) {
      await turns.enqueue({ threadId: roomId, botId, source: 'user', prompt: body.text });
    }
    this.ctx.bus.refresh({ scope: 'rooms' });
    return result;
  }

  /**
   * A member's prompt, built as its turn starts so it holds what the members before it said: the
   * room lines since it last spoke, or with a new session the latest stretch of the room. The
   * place it reaches is kept for when the turn succeeds.
   */
  async prompt(o: { roomId: string; bot: Bot; turn: TurnRow; fresh: boolean; t: T }): Promise<string> {
    const { roomId, bot, turn, fresh, t } = o;
    const [member] = await this.ctx.db
      .select()
      .from(schema.roomMembers)
      .where(and(eq(schema.roomMembers.roomId, roomId), eq(schema.roomMembers.botId, bot.id)))
      .limit(1);
    const settings = await this.services.settings.all();
    const bots = await this.services.bots.list({ includeArchived: true });
    const name = (m: Message) =>
      m.author === 'user'
        ? settings.userName || t('room.person')
        : m.author === `bot:${bot.id}`
          ? t('room.you', { name: bot.name })
          : (bots.find((b) => `bot:${b.id}` === m.author)?.name ?? m.author);
    const talk = (await this.services.threads.messages(roomId, { limit: 200 })).filter(
      (m) => (m.role === 'user' || m.role === 'assistant') && m.text.trim(),
    );
    const seen = member?.seenAt ?? null;
    const shown = fresh
      ? talk.slice(-ROOM_WINDOW)
      : talk.filter((m) => (!seen || new Date(m.createdAt) > seen) && m.author !== `bot:${bot.id}`);
    const lines: string[] = [];
    let size = 0;
    for (const m of [...shown].reverse()) {
      const text =
        m.text.length > HANDOFF_MESSAGE_CHARS ? `${m.text.slice(0, HANDOFF_MESSAGE_CHARS)}…` : m.text;
      const line = `${name(m)}: ${text}`;
      if (size + line.length > HANDOFF_CHARS) break;
      lines.unshift(line);
      size += line.length;
    }
    const last = talk.at(-1);
    if (last) this.cursors.set(turn.id, new Date(last.createdAt));
    const parts = [
      lines.length
        ? t(fresh ? 'room.promptFresh' : 'room.prompt', { lines: lines.join('\n\n') })
        : t('room.promptNone'),
    ];
    // Why a bot's own turn came: it was named, a new round began, or another bot answered it.
    if (turn.source !== 'user') parts.push(turn.prompt);
    parts.push(t('room.answer', { name: bot.name, silent: SILENT_REPLY }));
    return parts.join('\n\n');
  }

  /** Turn hook: saves the member's place, and lets the bots go on as the room allows. */
  async onTurnFinished(turn: TurnRow, outcome: TurnOutcome) {
    const cursor = this.cursors.get(turn.id);
    this.cursors.delete(turn.id);
    const room = await this.roomRow(turn.threadId);
    if (!room) return;
    // A turn stopped or failed hands nothing on: the person decides what comes next.
    if (!outcome.ok) return;
    if (cursor) {
      await this.ctx.db
        .update(schema.roomMembers)
        .set({ seenAt: cursor })
        .where(and(eq(schema.roomMembers.roomId, room.id), eq(schema.roomMembers.botId, turn.botId)));
    }
    const t = await this.services.settings.translator();
    const bots = await this.activeBots(room.id);
    const self = bots.find((b) => b.id === turn.botId);
    const spoke = !!outcome.text.trim() && !isSilentReply(outcome.text);
    if (spoke) {
      await this.ctx.db.update(schema.rooms).set({ roundSpoke: true }).where(eq(schema.rooms.id, room.id));
      const others = bots.filter((b) => b.id !== turn.botId);
      const named = findMentions(outcome.text, others);
      const ids = named.everyone ? others.map((b) => b.id) : named.ids;
      for (const botId of ids) {
        if (await this.waiting(room.id, botId)) continue;
        await this.followUp(room.id, botId, t('room.mentionedBy', { by: self?.name ?? '' }));
      }
    }
    // The round is over once no one is left to speak in it; another begins while the room allows
    // and the last one was not silent.
    const [busy] = await this.ctx.db
      .select({ id: schema.turns.id })
      .from(schema.turns)
      .where(
        and(
          eq(schema.turns.threadId, room.id),
          inArray(schema.turns.status, ['queued', 'running']),
          ne(schema.turns.id, turn.id),
        ),
      )
      .limit(1);
    if (busy) return;
    const [now] = await this.ctx.db.select().from(schema.rooms).where(eq(schema.rooms.id, room.id));
    if (!now || now.roundsLeft <= 0 || !now.roundSpoke) return;
    const [next] = await this.ctx.db
      .update(schema.rooms)
      .set({ roundsLeft: now.roundsLeft - 1, roundSpoke: false })
      .where(and(eq(schema.rooms.id, room.id), eq(schema.rooms.roundsLeft, now.roundsLeft)))
      .returning();
    if (!next) return;
    const n = now.rounds - next.roundsLeft;
    for (const b of bots) {
      await this.followUp(room.id, b.id, t('room.round', { n, total: now.rounds }));
    }
  }

  private async waiting(roomId: string, botId: string): Promise<boolean> {
    const [row] = await this.ctx.db
      .select({ id: schema.turns.id })
      .from(schema.turns)
      .where(
        and(
          eq(schema.turns.threadId, roomId),
          eq(schema.turns.botId, botId),
          eq(schema.turns.status, 'queued'),
        ),
      )
      .limit(1);
    return !!row;
  }

  /** A turn a bot starts for another, if the exchange's budget has one left. */
  private async followUp(roomId: string, botId: string, why: string): Promise<boolean> {
    const [room] = await this.ctx.db.select().from(schema.rooms).where(eq(schema.rooms.id, roomId));
    if (!room || room.botTurnsLeft <= 0) return false;
    const [taken] = await this.ctx.db
      .update(schema.rooms)
      .set({ botTurnsLeft: room.botTurnsLeft - 1 })
      .where(and(eq(schema.rooms.id, roomId), eq(schema.rooms.botTurnsLeft, room.botTurnsLeft)))
      .returning();
    if (!taken) return false;
    await this.services.turns.enqueue({ threadId: roomId, botId, source: 'bot', prompt: why });
    return true;
  }
}
