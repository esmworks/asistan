import { streamParts, type Message, type StreamPart } from '@leafbot/shared';
import { useLayoutEffect } from 'react';
import { useApprovals } from './queries';
import { useUi, type Stream } from './store';
import { restartTyping } from './typewriter';

/**
 * Places the cards a bot asks while its reply streams in where they were asked in that reply. The
 * card is saved the moment it is asked, the reply only when the turn ends, so the card would sit
 * above everything written before it and the person would have to scroll up to find the question.
 * `rows` are the conversation's rows; the result's `rows` leave out the cards that go in `parts`.
 */
export function useLiveCards(
  rows: Message[],
  stream: Stream | undefined,
  done: boolean,
): { rows: Message[]; parts: StreamPart<Message>[] } {
  const cuts = useUi((s) => s.cardCuts);
  const markCards = useUi((s) => s.markCards);
  const { data: approvals } = useApprovals();
  const live = stream && !done && stream.text ? stream : null;

  // Before the screen is drawn, so a card never shows above the text first and then moves.
  useLayoutEffect(() => {
    const fresh: Record<string, number> = {};
    for (const m of rows) {
      if (m.role !== 'approval' || !m.turnId || m.id in cuts) continue;
      // The bot waits for the answer, so the text that has arrived is the text before the card.
      if (stream?.turnId === m.turnId) fresh[m.id] = stream.text.length;
      // Asked before the reply wrote a word: what it writes after the answer goes below the card.
      else if (approvals?.some((a) => a.id === m.props.approvalId && a.status === 'pending')) fresh[m.id] = 0;
    }
    if (!Object.keys(fresh).length) return;
    // The text after the card is revealed from its own start, not from where the whole reply was.
    if (live && Object.values(fresh).some((at) => at > 0)) restartTyping(live.turnId);
    markCards(fresh);
  }, [rows, stream, live, cuts, approvals, markCards]);

  if (!live) return { rows, parts: [] };
  const cards = rows.filter((m) => m.role === 'approval' && m.turnId === live.turnId && m.id in cuts);
  if (!cards.length) return { rows, parts: streamParts(live.text, []) };
  const placed = new Set(cards.map((m) => m.id));
  return {
    rows: rows.filter((m) => !placed.has(m.id)),
    parts: streamParts(
      live.text,
      cards.map((card) => ({ card, at: cuts[card.id]! })),
    ),
  };
}
