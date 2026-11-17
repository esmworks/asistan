import type { Message } from '@yumakbot/shared';
import { useLayoutEffect, useMemo } from 'react';
import { useApprovals } from './queries';
import { useCardCuts } from './realtime';
import { newCardCuts, placeCards, type Stream } from './stream';

/**
 * Places the cards a bot asks while its reply streams in where they were asked in that reply, so
 * the person does not have to scroll up past the text to find the question. `messages` are the
 * conversation's rows; the result's `messages` leave out the cards that go inside the reply, and
 * `head` is the text written up to the last of them (stable while the rest streams in).
 */
export function useLiveCards(
  messages: readonly Message[],
  stream: Stream | undefined,
  done: boolean,
): { messages: readonly Message[]; cards: { card: Message; at: number }[]; head: string; end: number } {
  const [cuts, markCards] = useCardCuts();
  const { data: approvals } = useApprovals();
  const pending = useMemo(
    () => new Set((approvals ?? []).filter((a) => a.status === 'pending').map((a) => a.id)),
    [approvals],
  );

  // Before the screen is drawn, so a card never shows above the text first and then moves.
  useLayoutEffect(() => {
    const fresh = newCardCuts(messages, stream, pending, cuts);
    if (Object.keys(fresh).length) markCards(fresh);
  }, [messages, stream, pending, cuts, markCards]);

  const liveTurn = stream && !done && stream.text ? stream.turnId : null;
  const placed = useMemo(() => placeCards(messages, liveTurn, cuts), [messages, liveTurn, cuts]);
  const end = Math.min(placed.end, stream?.text.length ?? 0);
  return { ...placed, end, head: stream?.text.slice(0, end) ?? '' };
}
