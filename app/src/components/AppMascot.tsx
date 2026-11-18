import { ShapeArt, type AvatarMotion } from '@/components/BotAvatar';
import type { BotActivity } from '@/lib/botActivity';
import { cn } from '@/lib/utils';

/**
 * The app's own colours, those of its icon. Fixed rather than the brand colour: that one is the accent of
 * the interface and turns into the selected bot's colour, while the app keeps one face.
 */
const TILE = 'linear-gradient(180deg, #2a5a3c 0%, #12281a 100%)';
export const MASCOT_COLOR = '#4fae74';

/**
 * Yumak Bot itself, drawn as its icon: the green plush rising from the bottom of a dark green tile.
 * Its eyes live like a bot's, so the first screens greet with the same character the Dock shows.
 */
export function AppMascot({
  activity,
  motion = 'still',
  className,
}: {
  activity?: BotActivity;
  motion?: AvatarMotion;
  className?: string;
}) {
  return (
    <span
      className={cn('relative block size-full overflow-hidden rounded-[22%] shadow-sm', className)}
      style={{ background: TILE }}
      aria-hidden
    >
      {/* Wider than the tile and set low, so the body fills it side to side and is cut by its bottom. */}
      <span className="absolute top-[24%] left-[-7.5%] block h-[115%] w-[115%]">
        <ShapeArt shape="blob" color={MASCOT_COLOR} activity={activity} motion={motion} seed="yumakbot" />
      </span>
    </span>
  );
}
