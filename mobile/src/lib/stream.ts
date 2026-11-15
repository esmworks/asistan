import type { Message } from '@yumakbot/shared';

/** The reply a bot is writing now, as it arrives over the socket, before it is saved. */
export interface Stream {
  turnId: string;
  text: string;
}

export type Streams = Readonly<Record<string, Stream>>;

/** Adds a piece of a reply; a piece of a new turn starts that conversation's text over. */
export function appendStream(streams: Streams, threadId: string, turnId: string, text: string): Streams {
  const cur = streams[threadId];
  const next = cur && cur.turnId === turnId ? cur.text + text : text;
  return { ...streams, [threadId]: { turnId, text: next } };
}

/** Drops a conversation's text, only when it is still that turn's if one is named. */
export function dropStream(streams: Streams, threadId: string, turnId?: string): Streams {
  const cur = streams[threadId];
  if (!cur || (turnId && cur.turnId !== turnId)) return streams;
  const rest = { ...streams };
  delete rest[threadId];
  return rest;
}

/** Whether the saved reply of the streamed turn is already in the list, so the stream is not shown twice. */
export function streamSaved(stream: Stream | undefined, messages: readonly Message[]): boolean {
  return !!stream && messages.some((m) => m.turnId === stream.turnId && m.role === 'assistant');
}

/**
 * The messages to show: the saved ones, then those sent from this phone that the server has not
 * listed yet. One already listed under the same client id is not shown again.
 */
export function withPending(messages: readonly Message[], pending: readonly Message[]): Message[] {
  const listed = new Set(messages.map((m) => m.clientId).filter(Boolean));
  return [...messages, ...pending.filter((p) => !listed.has(p.clientId))];
}

/** An id for a message sent from this phone, so a resend is not saved twice. */
export function newClientId(): string {
  const rand = () => Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  return `${Date.now().toString(36)}-${rand()}${rand()}`;
}
