import type { BotActivity } from './activity';

/**
 * A direction in degrees: right and up are positive. `AT_YOU` is looking at the person. The looks stay
 * within about 12 degrees of it.
 */
export interface Spot {
  yaw: number;
  pitch: number;
}

/** A look, with how open the lids are: 1 open, 0 shut. */
export interface Look extends Spot {
  lid: number;
}

export const AT_YOU: Spot = { yaw: 0, pitch: 8 };

interface Habit {
  /** Where it looks, with how often it looks there and, for a look held longer or shorter, how long. */
  spots: readonly (Spot & { weight?: number; hold?: readonly [number, number] })[];
  /** Looks at the spots one after another, back to the first after the last, as if reading a line. */
  inOrder?: boolean;
  /** Seconds a look is held, at random in this range. */
  hold: readonly [number, number];
  /** Degrees of slow drift while a look is held; 0 holds the eyes still. */
  drift: number;
  /** Seconds between blinks, at random in this range. */
  blink: readonly [number, number];
}

/** A line read from left to right and back again, a little lower each way, as eyes go over a page. */
const READ_LINES: readonly Spot[] = [
  { yaw: -9, pitch: -8 },
  { yaw: -3, pitch: -8 },
  { yaw: 3, pitch: -8 },
  { yaw: 9, pitch: -8 },
  { yaw: 4, pitch: -10 },
  { yaw: -2, pitch: -10 },
  { yaw: -8, pitch: -10 },
];

/**
 * How the eyes behave for each activity. A bot at rest mostly looks at the person and now and then
 * glances away; thinking (which is also when it runs its tools and reads what they return), it looks
 * up to one side, then goes over the page, line by line; writing, it reads its line from left to
 * right; browsing, it scans the page; asking, it looks at the person and glances down at the card.
 */
const HABITS: Record<BotActivity, Habit> = {
  idle: {
    spots: [
      { ...AT_YOU, weight: 4 },
      { yaw: -12, pitch: 7 },
      { yaw: 12, pitch: 7 },
      { yaw: 0, pitch: 20 },
      { yaw: 0, pitch: -4 },
      { yaw: -8, pitch: 17 },
      { yaw: 8, pitch: 17 },
      { yaw: -8, pitch: 0 },
      { yaw: 8, pitch: 0 },
    ],
    hold: [2.2, 5.5],
    drift: 1.2,
    blink: [2.5, 6],
  },
  queued: {
    spots: [
      { yaw: 0, pitch: -2, weight: 3 },
      { yaw: -6, pitch: -1 },
      { yaw: 6, pitch: -1 },
    ],
    hold: [3, 7],
    drift: 0.6,
    blink: [4, 8],
  },
  thinking: {
    spots: [
      { yaw: 10, pitch: 16, hold: [0.8, 1.5] },
      ...READ_LINES,
      ...READ_LINES,
      { yaw: -10, pitch: 16, hold: [0.7, 1.3] },
      ...READ_LINES,
    ],
    inOrder: true,
    hold: [0.12, 0.24],
    drift: 0,
    blink: [3, 6],
  },
  writing: {
    spots: [
      { yaw: -8, pitch: -5 },
      { yaw: -3, pitch: -5 },
      { yaw: 3, pitch: -5 },
      { yaw: 8, pitch: -5 },
    ],
    inOrder: true,
    hold: [0.15, 0.3],
    drift: 0,
    blink: [2.5, 5],
  },
  browsing: {
    spots: [
      { yaw: -12, pitch: 4 },
      { yaw: 12, pitch: 4 },
      { yaw: -6, pitch: -2 },
      { yaw: 6, pitch: -2 },
      { yaw: 0, pitch: 9 },
      { yaw: -12, pitch: -1 },
      { yaw: 12, pitch: -1 },
    ],
    hold: [0.25, 0.7],
    drift: 0,
    blink: [2.5, 5],
  },
  waiting: {
    spots: [
      { ...AT_YOU, weight: 6 },
      { yaw: 0, pitch: -5 },
    ],
    hold: [1.8, 4],
    drift: 0.6,
    blink: [2, 4.5],
  },
};

/** Seconds a blink takes; the lids close a little faster than they open. */
const BLINK_SECONDS = 0.18;
/** How often a blink comes twice in a row. */
const DOUBLE_BLINK = 0.18;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const between = (range: readonly [number, number], r: number) => range[0] + r * (range[1] - range[0]);

/**
 * A quick jump from one spot to the next; a longer jump takes a little longer, as an eye does. Kept
 * short so a bot reading a page skims it briskly rather than drifting from word to word.
 */
export const saccadeSeconds = (from: Spot, to: Spot) =>
  0.06 + Math.hypot(to.yaw - from.yaw, to.pitch - from.pitch) * 0.003;

/** How open the lids are `s` seconds into a blink: 1 open, 0 shut. */
export function lidAt(s: number) {
  const r = s / BLINK_SECONDS;
  if (r <= 0 || r >= 1) return 1;
  return r < 0.45 ? 1 - r / 0.45 : (r - 0.45) / 0.55;
}

/**
 * Decides where a bot's eyes look and when they blink. It holds a look and jumps quickly to the next
 * one its activity calls for. `look(t)` takes seconds on a clock every avatar of the bot shares, so
 * they all look and blink together.
 */
export class GazeDirector {
  private habit: Habit;
  private now: Spot;
  private from: Spot;
  private to: Spot;
  private moveAt = 0;
  private moveFor = 0;
  private holdUntil: number;
  private blinkAt = -1;
  private nextBlink: number;
  private index = 0;
  private last: number | null = null;

  constructor(
    activity: BotActivity,
    private readonly random: () => number = Math.random,
  ) {
    this.habit = HABITS[activity];
    this.now = this.from = this.to = this.choose();
    this.holdUntil = between(this.holdOf(this.now), this.random());
    this.nextBlink = between(this.habit.blink, this.random());
  }

  /** A new activity looks somewhere it calls for at once. */
  setActivity(activity: BotActivity) {
    const habit = HABITS[activity];
    if (habit === this.habit) return;
    this.habit = habit;
    this.index = 0;
    if (this.last !== null) this.holdUntil = this.last;
  }

  look(t: number): Look {
    if (this.last === null) {
      // The first look starts the timetable; until then it is counted from zero.
      this.holdUntil += t;
      this.nextBlink += t;
      this.last = t;
    }
    if (t < this.last) {
      this.from = this.to = this.now;
      this.moveFor = 0;
      this.holdUntil = t + between(this.holdOf(this.now), this.random());
      this.nextBlink = t + between(this.habit.blink, this.random());
      this.blinkAt = -1;
    }
    this.last = t;

    if (t >= this.nextBlink) {
      this.blinkAt = t;
      this.nextBlink =
        this.random() < DOUBLE_BLINK
          ? t + BLINK_SECONDS + 0.06
          : t + between(this.habit.blink, this.random());
    }
    const lid = this.blinkAt >= 0 ? lidAt(t - this.blinkAt) : 1;

    if (t >= this.holdUntil) {
      this.from = this.now;
      this.to = this.choose();
      this.moveAt = t;
      this.moveFor = saccadeSeconds(this.from, this.to);
      this.holdUntil = t + this.moveFor + between(this.holdOf(this.to), this.random());
    }
    const p = this.moveFor > 0 ? clamp((t - this.moveAt) / this.moveFor, 0, 1) : 1;
    const e = easeOut(p);
    this.now = {
      yaw: this.from.yaw + (this.to.yaw - this.from.yaw) * e,
      pitch: this.from.pitch + (this.to.pitch - this.from.pitch) * e,
    };
    // A slow sway on top keeps a held look alive; it is a function of the shared clock, so it is the
    // same on every avatar of the bot.
    const d = this.habit.drift;
    return this.result(
      {
        yaw: this.now.yaw + d * (Math.sin(t * 0.56 + 0.4) + 0.3 * Math.sin(t * 1.7 + 2.1)),
        pitch: this.now.pitch + d * 0.7 * (Math.sin(t * 0.69 + 1.3) + 0.3 * Math.sin(t * 1.46 + 0.7)),
      },
      lid,
    );
  }

  private result(at: Spot, lid: number): Look {
    return { yaw: at.yaw, pitch: at.pitch, lid };
  }

  /** How long a look at `spot` is held: its own range, or its habit's. */
  private holdOf(spot: Spot): readonly [number, number] {
    const own = this.habit.spots.find((s) => s.yaw === spot.yaw && s.pitch === spot.pitch);
    return own?.hold ?? this.habit.hold;
  }

  /** The next spot: the next one in line, or one at random by weight that is not the current one. */
  private choose(): Spot {
    const { spots, inOrder } = this.habit;
    if (inOrder) {
      const spot = spots[this.index % spots.length]!;
      this.index++;
      return { yaw: spot.yaw, pitch: spot.pitch };
    }
    const current = this.to as Spot | undefined;
    const others = spots.filter((s) => !current || s.yaw !== current.yaw || s.pitch !== current.pitch);
    const pool = others.length ? others : spots;
    const total = pool.reduce((sum, s) => sum + (s.weight ?? 1), 0);
    let r = this.random() * total;
    for (const s of pool) {
      r -= s.weight ?? 1;
      if (r < 0) return { yaw: s.yaw, pitch: s.pitch };
    }
    const s = pool[pool.length - 1]!;
    return { yaw: s.yaw, pitch: s.pitch };
  }
}

const directors = new Map<string, GazeDirector>();

/** The one director of a bot, which every avatar of the bot uses. Without a key the avatar has its own. */
export function gazeOf(key: string | undefined, activity: BotActivity): GazeDirector {
  if (!key) return new GazeDirector(activity);
  let d = directors.get(key);
  if (!d) directors.set(key, (d = new GazeDirector(activity)));
  return d;
}

/**
 * A look as an object avatar takes it: -1 to 1 each way, right and down positive. Its engine turns the
 * body to face the spot and moves the eyes a share of the way on top.
 */
export function lookTarget(at: Spot) {
  return { x: clamp(at.yaw / 12, -1, 1), y: clamp(-(at.pitch - AT_YOU.pitch) / 14, -1, 1) };
}

/** The least distance, in CSS px, over which an object avatar's look reaches about three quarters. */
const OBJECT_REACH = 56;

/**
 * Where an object avatar looks for a pointer, as `lookTarget` takes it: from its eyes, measured
 * against its own size rather than the engine's 160 px floor. With that floor a small avatar in a
 * list barely turned for a pointer right beside it, and seemed slow just where it was watched most.
 * The look saturates softly further out, as the engine's does.
 */
export function pointerLook(
  pointer: { x: number; y: number },
  box: { left: number; top: number; width: number; height: number },
  eyes: { x: number; y: number },
) {
  const reach = Math.max(box.width, box.height, OBJECT_REACH);
  const dx = (pointer.x - (box.left + box.width * eyes.x)) / reach;
  const dy = (pointer.y - (box.top + box.height * eyes.y)) / reach;
  const m = Math.hypot(dx, dy);
  if (!Number.isFinite(m) || m < 1e-9) return { x: 0, y: 0 };
  const k = Math.tanh(m) / m;
  return { x: dx * k, y: dy * k };
}

/** The sway and bob a working object avatar adds to its turn, in radians, on the shared clock. */
export function swayAt(t: number) {
  return { yaw: 0.08 * Math.sin(t * 1.1 + 0.6), pitch: 0.04 * Math.sin(t * 2.3) };
}

/** Seconds on the clock every avatar shares. */
export const sharedClock = () => performance.now() / 1000;
