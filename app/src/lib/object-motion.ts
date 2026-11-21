import type { AvatarMood, AvatarState } from 'open-bot-avatar';
import type { BotActivity } from './activity';

/**
 * How an object avatar acts out what its bot is doing, the same in the web app and on the phone. Kept
 * free of React and of the page, so each app wraps it in its own hooks.
 */

/** Activities that end in a finished piece of work; a bot that goes from one of them to rest is done. */
const WORKING: ReadonlySet<BotActivity> = new Set(['thinking', 'writing', 'browsing']);

/** How long a bot shows it is done: a few hops, then it rests. */
export const CELEBRATE_MS = 4000;

/**
 * Whether going from `previous` to `next` is finishing work. Only the move from working to rest
 * counts: a bot that stops to ask someone, or was only queued, is not done yet.
 */
export const finishes = (previous: BotActivity, next: BotActivity) =>
  WORKING.has(previous) && next === 'idle';

/**
 * How each activity shows on an object avatar: ribbons sweeping round it while it writes or reads a
 * page, an exclamation mark when it needs someone, and a quiet wait while its turn has not come.
 * Thinking, which is also when it runs its tools, is not the engine's own: that one hides the body
 * behind three dots for as long as a tool runs. The bot keeps its face instead and is steered (see
 * `steered`), looking up to one side, then going over the page line by line, its head swaying all along.
 */
const OBJECT_STATES: Record<BotActivity, AvatarState> = {
  idle: 'idle',
  queued: 'waiting',
  thinking: 'idle',
  writing: 'working',
  browsing: 'working',
  waiting: 'blocked',
};

/**
 * The engine's state and mood for an activity. Just done, it smiles with its eyes and hops, the
 * engine's happy mood at rest, then rests: the engine's own `done` turns it round with ribbons flying,
 * more than a finished task asks.
 */
export function objectLook(
  activity: BotActivity,
  celebrating: boolean,
): { state: AvatarState; mood: AvatarMood } {
  return celebrating ? { state: 'idle', mood: 'happy' } : { state: OBJECT_STATES[activity], mood: 'neutral' };
}

/** Whether a moving avatar's look and sway are steered frame by frame from its bot's gaze. */
export const steered = (activity: BotActivity) => activity === 'thinking';

/** White eyes: on a coloured body they read as a face rather than as holes. */
export const OBJECT_EYES = '#ffffff';
