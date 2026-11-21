import type { ExpressionId, Look } from '@norbert_bodziony/bloub';
import type { BotActivity } from './activity';

/**
 * A direction in degrees: right and up are positive. `AT_YOU` is looking at the person. Its own looks
 * stay within about 12 degrees of it and following the pointer within 18: further out the eyes slide
 * towards the edge of the sphere they sit on, skew, and on a narrow body such as the cloud or the
 * triangle run off its edge.
 */
export interface Spot {
  yaw: number;
  pitch: number;
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
      { yaw: 10, pitch: 16, hold: [1.2, 2.4] },
      ...READ_LINES,
      ...READ_LINES,
      { yaw: -10, pitch: 16, hold: [1, 2] },
      ...READ_LINES,
    ],
    inOrder: true,
    hold: [0.3, 0.6],
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
    hold: [0.35, 0.75],
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
    hold: [0.5, 1.4],
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

/** How far the eyes turn towards a pointer at the edge of the row or button the avatar sits in. */
const FOLLOW = { yaw: 18, pitch: 16 };
/** Seconds for the eyes to catch most of the way up with a moving pointer. */
const FOLLOW_LAG = 0.07;
/** Seconds a blink takes; the lids close a little faster than they open. */
const BLINK_SECONDS = 0.18;
/** How often a blink comes twice in a row. */
const DOUBLE_BLINK = 0.18;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const between = (range: readonly [number, number], r: number) => range[0] + r * (range[1] - range[0]);

/** A quick jump from one spot to the next; a longer jump takes a little longer, as an eye does. */
export const saccadeSeconds = (from: Spot, to: Spot) =>
  0.1 + Math.hypot(to.yaw - from.yaw, to.pitch - from.pitch) * 0.004;

/** How open the lids are `s` seconds into a blink: 1 open, 0 shut. */
export function lidAt(s: number) {
  const r = s / BLINK_SECONDS;
  if (r <= 0 || r >= 1) return 1;
  return r < 0.45 ? 1 - r / 0.45 : (r - 0.45) / 0.55;
}

/**
 * Decides where a bot's eyes look and when they blink. It holds a look, jumps quickly to the next one
 * its activity calls for, and follows the pointer while one is over an avatar of the bot. `look(t)`
 * takes seconds on a clock every avatar of the bot shares, so they all look and blink together.
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
  private pointer: { nx: number; ny: number } | null = null;

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

  /**
   * The pointer, from the avatar's centre, in half the window: -1 to 1, right and down positive.
   * Null when it leaves; the eyes go back to their own looks.
   */
  setPointer(pointer: { nx: number; ny: number } | null) {
    if (!pointer && this.pointer && this.last !== null) this.holdUntil = this.last;
    this.pointer = pointer;
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
    const dt = clamp(t - this.last, 0, 0.1);
    this.last = t;

    if (t >= this.nextBlink) {
      this.blinkAt = t;
      this.nextBlink =
        this.random() < DOUBLE_BLINK
          ? t + BLINK_SECONDS + 0.06
          : t + between(this.habit.blink, this.random());
    }
    const lid = this.blinkAt >= 0 ? lidAt(t - this.blinkAt) : 1;

    if (this.pointer) {
      const target = {
        yaw: clamp(this.pointer.nx, -1, 1) * FOLLOW.yaw,
        pitch: AT_YOU.pitch - clamp(this.pointer.ny, -1, 1) * FOLLOW.pitch,
      };
      const k = 1 - Math.exp(-dt / FOLLOW_LAG);
      this.now = {
        yaw: this.now.yaw + (target.yaw - this.now.yaw) * k,
        pitch: this.now.pitch + (target.pitch - this.now.pitch) * k,
      };
      return this.result(this.now, lid);
    }

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

  /** The engine's own drift and blinks are off: they run on each avatar's own clock. */
  private result(at: Spot, lid: number): Look {
    return { yaw: at.yaw, pitch: at.pitch, mix: 1, spin: 0, wander: 0, blink: 0, lid };
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

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Where a pointer is, for `setPointer`, as a share of the way from the avatar's centre to the edge of
 * the row or button it sits in, each way on its own. The eyes follow only while the pointer is over
 * that row, so its edges are as far as the pointer goes: at the top edge of a low row the eyes already
 * look all the way up, and an avatar at the start of a row still looks back to its left.
 */
export function pointerIn(x: number, y: number, avatar: Box, row: Box) {
  const cx = (avatar.left + avatar.right) / 2;
  const cy = (avatar.top + avatar.bottom) / 2;
  // A pointer this close to the centre is not yet all the way to one side.
  const least = (avatar.right - avatar.left) / 2 + 8;
  const share = (d: number, before: number, after: number) =>
    clamp(d / Math.max(least, d < 0 ? before : after), -1, 1);
  return {
    nx: share(x - cx, cx - row.left, row.right - cx),
    ny: share(y - cy, cy - row.top, row.bottom - cy),
  };
}

/** Where the head sits: shifted by a share of the avatar's size, right and down positive, and tilted. */
export interface HeadPose {
  x: number;
  y: number;
  /** Degrees, clockwise. */
  tilt: number;
}

export const HEAD_REST: HeadPose = { x: 0, y: 0, tilt: 0 };

/** Seconds for the head to catch most of the way up with the eyes; it turns after them. */
export const HEAD_LAG = 0.22;

/**
 * Where the head goes for a look. It turns and leans the way the eyes look: down over a page, up while
 * it ponders, to the side it glances at. A working bot's head also sways and bobs the whole time; one
 * at rest only follows its eyes, by half as much. Worked out from the shared clock, like the eyes.
 */
export function headFor(look: Spot, busy: boolean, t: number): HeadPose {
  const k = busy ? 1 : 0.45;
  const sway = busy ? 1 : 0;
  return {
    x: k * look.yaw * 0.0035,
    y: -k * (look.pitch - AT_YOU.pitch) * 0.003 + sway * 0.012 * Math.sin(t * 2.3),
    tilt: k * look.yaw * 0.45 + sway * 2.4 * Math.sin(t * 1.1 + 0.6),
  };
}

/** One step of the head towards `target`, `dt` seconds after the last. */
export function headToward(head: HeadPose, target: HeadPose, dt: number): HeadPose {
  const k = 1 - Math.exp(-clamp(dt, 0, 0.1) / HEAD_LAG);
  return {
    x: head.x + (target.x - head.x) * k,
    y: head.y + (target.y - head.y) * k,
    tilt: head.tilt + (target.tilt - head.tilt) * k,
  };
}

/** Seconds on the clock every avatar shares. */
export const sharedClock = () => performance.now() / 1000;

/** How long a working bot keeps one face. */
export const FACE_MS = 5000;

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * The face a working bot has at `ms` on the shared clock. It is worked out from the time alone, so
 * every avatar of the bot shows the same face and changes it at the same moment, almost never to the
 * face it just had.
 */
export function workingFaceAt(key: string, faces: readonly ExpressionId[], ms: number): ExpressionId {
  const slot = Math.floor(ms / FACE_MS);
  const pick = (n: number) => hash(`${key}:${n}`) % faces.length;
  let i = pick(slot);
  if (faces.length > 1 && i === pick(slot - 1)) i = (i + 1) % faces.length;
  return faces[i]!;
}
