import mascot from '@/assets/mascot.webp';
import { cn } from '@/lib/utils';

/**
 * The app's own colours, those of its icon. Fixed rather than the brand colour: that one is the accent of
 * the interface and turns into the selected bot's colour, while the app keeps one face. The picture brings
 * its own background; the tile behind it only shows until the picture has loaded.
 */
const TILE = 'linear-gradient(180deg, #2b533d 0%, #28503b 100%)';
export const MASCOT_COLOR = '#56b47f';

/**
 * Leaf Bot itself, drawn as its icon: the round green bot coming in from the bottom right corner of a
 * dark green tile. A picture of the icon's own art rather than a live avatar: the live one keeps its eyes
 * in the middle of its body, which here lies outside the tile.
 */
export function AppMascot({ className }: { className?: string }) {
  return (
    <span
      className={cn('relative block size-full overflow-hidden rounded-[22%] shadow-sm', className)}
      style={{ background: TILE }}
      aria-hidden
    >
      <img src={mascot} alt="" className="size-full" draggable={false} />
    </span>
  );
}
