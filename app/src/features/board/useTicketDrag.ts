import type { Ticket, TicketStatus } from '@yumakbot/shared';
import { useEffect, useRef, useState } from 'react';

/*
 * Moving a ticket to another column, or to another place in its own, by pressing anywhere on its
 * card. Pointer events rather than
 * native drag and drop, so a short press still opens the ticket, the copy under the pointer looks
 * like the card itself, and the columns can be scrolled while carrying it. Columns carry
 * `data-board-status`. Only a mouse or pen moves cards: on a touch screen a press scrolls, and the
 * status is changed from the ticket's details.
 */

export interface TicketDrag {
  ticket: Ticket;
  x: number;
  y: number;
  /** Where on the card it was taken, so the copy keeps that point under the pointer. */
  dx: number;
  dy: number;
  width: number;
  over: TicketStatus | null;
  /** The card it would land before in that column; null for the end of it. */
  beforeId: string | null;
}

const THRESHOLD = 5;
const EDGE = 56;

export function useTicketDrag(
  scroller: React.RefObject<HTMLElement | null>,
  onDrop: (ticket: Ticket, status: TicketStatus, beforeId: string | null) => void,
) {
  const [drag, setDrag] = useState<TicketDrag | null>(null);
  /** Set when a move ends, so the click that follows the release does not open the card. */
  const moved = useRef(false);
  const stop = useRef<(() => void) | null>(null);
  const dropRef = useRef(onDrop);
  useEffect(() => {
    dropRef.current = onDrop;
  });
  useEffect(() => () => stop.current?.(), []);

  const grab = (e: React.PointerEvent, ticket: Ticket) => {
    if (e.button !== 0 || e.pointerType === 'touch') return;
    const card = e.currentTarget.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY };
    let current: TicketDrag | null = null;

    const placeAt = (x: number, y: number) => {
      const column = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-board-status]');
      const over = (column?.dataset.boardStatus as TicketStatus | undefined) ?? null;
      if (!column || !over) return { over: null, beforeId: null };
      // The first card of that column whose middle is below the pointer; the moved card itself
      // does not count.
      const cards = [...column.querySelectorAll<HTMLElement>('[data-ticket-id]')].filter(
        (c) =>
          c.dataset.ticketStatus === over && c.dataset.ticketId !== ticket.id && !c.closest('[data-lifted]'),
      );
      const below = cards.find((c) => {
        const r = c.getBoundingClientRect();
        return r.top + r.height / 2 > y;
      });
      return { over, beforeId: below?.dataset.ticketId ?? null };
    };
    const move = (ev: PointerEvent) => {
      if (!current && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < THRESHOLD) return;
      ev.preventDefault();
      // Near an edge of the columns, they scroll toward it.
      const box = scroller.current?.getBoundingClientRect();
      if (box && scroller.current) {
        if (ev.clientX < box.left + EDGE) scroller.current.scrollLeft -= 12;
        else if (ev.clientX > box.right - EDGE) scroller.current.scrollLeft += 12;
      }
      current = {
        ticket,
        x: ev.clientX,
        y: ev.clientY,
        dx: start.x - card.left,
        dy: start.y - card.top,
        width: card.width,
        ...placeAt(ev.clientX, ev.clientY),
      };
      setDrag(current);
    };
    const end = (drop: boolean) => {
      stop.current?.();
      if (!current) return;
      const done = current;
      current = null;
      moved.current = true;
      setTimeout(() => (moved.current = false), 0);
      if (drop && done.over) dropRef.current(ticket, done.over, done.beforeId);
      setDrag(null);
    };
    const up = () => end(true);
    const cancel = () => end(false);
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || !current) return;
      // Escape puts the card back; it must not also close the board.
      ev.preventDefault();
      ev.stopPropagation();
      end(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key, true);
    stop.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key, true);
      stop.current = null;
    };
  };

  return { drag, grab, wasMoved: () => moved.current };
}
