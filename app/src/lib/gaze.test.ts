import { describe, expect, it } from 'vitest';
import {
  AT_YOU,
  FACE_MS,
  GazeDirector,
  gazeOf,
  lidAt,
  pointerIn,
  saccadeSeconds,
  workingFaceAt,
} from './gaze';

/** The same numbers every run. */
function seeded(seed = 1) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

/** Samples the director at 60 frames a second from `from` to `to` seconds. */
function run(g: GazeDirector, from: number, to: number) {
  const out: { t: number; yaw: number; pitch: number }[] = [];
  for (let t = from; t <= to; t += 1 / 60) {
    const l = g.look(t);
    out.push({ t, yaw: l.yaw, pitch: l.pitch });
  }
  return out;
}

/** Further apart than the slow drift goes: the eyes jumped. */
const moved = (a: { yaw: number; pitch: number }, b: { yaw: number; pitch: number }, by = 3) =>
  Math.hypot(a.yaw - b.yaw, a.pitch - b.pitch) > by;

describe('gaze director', () => {
  it('holds each look for a while and jumps quickly between looks', () => {
    const frames = run(new GazeDirector('idle', seeded()), 0, 30);
    // Count the stretches where the eyes do not move; at rest they must last at least the shortest hold.
    let still = 0;
    const holds: number[] = [];
    for (let i = 1; i < frames.length; i++) {
      // A frame that moves this far is part of a jump; the drift is far slower.
      if (moved(frames[i]!, frames[i - 1]!, 0.2)) {
        if (still) holds.push(still / 60);
        still = 0;
      } else still++;
    }
    expect(holds.length).toBeGreaterThan(2);
    for (const h of holds.slice(0, -1)) expect(h).toBeGreaterThan(2);
  });

  it('reads its line from left to right while writing', () => {
    const g = new GazeDirector('writing', seeded());
    // Where the eyes rest for a few frames, not the frames they pass on the way.
    const frames = run(g, 0, 6).map((f) => Math.round(f.yaw * 10) / 10);
    const yaws: number[] = [];
    for (let i = 2; i < frames.length; i++) {
      const y = frames[i]!;
      if (y === frames[i - 1] && y === frames[i - 2] && yaws[yaws.length - 1] !== y) yaws.push(y);
    }
    expect(yaws.slice(0, 5)).toEqual([-8, -3, 3, 8, -8]);
  });

  it('looks up while thinking', () => {
    const frames = run(new GazeDirector('thinking', seeded(7)), 0, 20);
    for (const f of frames) expect(f.pitch).toBeGreaterThanOrEqual(15);
  });

  it('turns to a new activity at once', () => {
    const g = new GazeDirector('idle', seeded());
    run(g, 0, 1);
    g.setActivity('thinking');
    const after = run(g, 1, 1.6);
    expect(after[after.length - 1]!.pitch).toBeGreaterThanOrEqual(15);
  });

  it('follows the pointer and goes back to its own looks when it leaves', () => {
    const g = new GazeDirector('idle', seeded());
    run(g, 0, 1);
    g.setPointer({ nx: 1, ny: 1 });
    const end = run(g, 1, 1.6).at(-1)!;
    expect(end.yaw).toBeCloseTo(18, 0);
    expect(end.pitch).toBeCloseTo(AT_YOU.pitch - 16, 0);
    g.setPointer(null);
    const back = run(g, 1.6, 2.4).at(-1)!;
    expect(moved(back, end)).toBe(true);
  });

  it('carries on when its clock starts again', () => {
    const g = new GazeDirector('browsing', seeded());
    run(g, 0, 5);
    const frames = run(g, 0, 5);
    for (const f of frames) {
      expect(Number.isFinite(f.yaw) && Number.isFinite(f.pitch)).toBe(true);
      expect(Math.abs(f.yaw)).toBeLessThanOrEqual(12);
    }
  });

  it('always overrides the face and leaves no drift or blinks to the engine', () => {
    const l = new GazeDirector('waiting', seeded()).look(0);
    expect(l.mix).toBe(1);
    expect(l.spin).toBe(0);
    expect(l.wander).toBe(0);
    expect(l.blink).toBe(0);
  });

  it('blinks every few seconds, shutting the lids for a moment', () => {
    const g = new GazeDirector('idle', seeded(3));
    let blinks = 0;
    let open = true;
    for (let t = 100; t < 130; t += 1 / 120) {
      const lid = g.look(t).lid ?? 1;
      if (open && lid < 0.2) {
        blinks++;
        open = false;
      } else if (lid > 0.8) open = true;
    }
    expect(blinks).toBeGreaterThanOrEqual(4);
    expect(blinks).toBeLessThanOrEqual(15);
    expect(lidAt(0.08)).toBeLessThan(0.1);
    expect(lidAt(0.5)).toBe(1);
  });

  it('starts its timetable at the first look, however late the clock is', () => {
    const g = new GazeDirector('idle', seeded());
    const first = g.look(5000);
    const soon = run(g, 5000, 5001.5);
    for (const f of soon) expect(moved(f, first)).toBe(false);
  });

  it('gives every avatar of a bot the same director', () => {
    expect(gazeOf('bot-1', 'idle')).toBe(gazeOf('bot-1', 'thinking'));
    expect(gazeOf('bot-1', 'idle')).not.toBe(gazeOf('bot-2', 'idle'));
    expect(gazeOf(undefined, 'idle')).not.toBe(gazeOf(undefined, 'idle'));
  });

  it('glances up, down, left and right at rest', () => {
    const frames = run(new GazeDirector('idle', seeded(5)), 0, 240);
    const yaws = frames.map((f) => f.yaw - AT_YOU.yaw);
    const pitches = frames.map((f) => f.pitch - AT_YOU.pitch);
    expect(Math.max(...yaws)).toBeGreaterThan(10);
    expect(Math.min(...yaws)).toBeLessThan(-10);
    expect(Math.max(...pitches)).toBeGreaterThan(10);
    expect(Math.min(...pitches)).toBeLessThan(-10);
  });

  it('looks all the way to each edge of the row the pointer is in', () => {
    // A 28 px avatar at the start of a 260 by 44 px row.
    const avatar = { left: 8, top: 8, right: 36, bottom: 36 };
    const row = { left: 0, top: 0, right: 260, bottom: 44 };
    expect(pointerIn(22, 22, avatar, row)).toEqual({ nx: 0, ny: 0 });
    expect(pointerIn(259, 22, avatar, row).nx).toBeCloseTo(1, 1);
    expect(pointerIn(0, 22, avatar, row).nx).toBe(-1);
    expect(pointerIn(22, 0, avatar, row).ny).toBe(-1);
    expect(pointerIn(22, 44, avatar, row).ny).toBe(1);
    // Halfway along the row is about halfway round.
    expect(pointerIn(141, 22, avatar, row).nx).toBeCloseTo(0.5, 1);
  });

  it('takes longer for a longer jump', () => {
    expect(saccadeSeconds(AT_YOU, { yaw: 18, pitch: 8 })).toBeGreaterThan(
      saccadeSeconds(AT_YOU, { yaw: 4, pitch: 8 }),
    );
  });
});

describe('working faces', () => {
  const faces = ['attentif', 'curieux', 'confus', 'mefiant'] as const;

  it('are the same for the same bot at the same time', () => {
    expect(workingFaceAt('bot-1', faces, 12_345)).toBe(workingFaceAt('bot-1', faces, 12_999));
  });

  it('change every few seconds', () => {
    const seen = new Set<string>();
    let changes = 0;
    let last = workingFaceAt('bot-1', faces, 0);
    for (let ms = 0; ms < FACE_MS * 40; ms += FACE_MS) {
      const f = workingFaceAt('bot-1', faces, ms);
      seen.add(f);
      if (f !== last) changes++;
      last = f;
    }
    expect(seen.size).toBe(faces.length);
    expect(changes).toBeGreaterThan(30);
  });
});
