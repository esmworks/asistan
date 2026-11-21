import { BRAND_COLOR, type AvatarShape, type ObjectAvatar } from '@leafbot/shared';
import type { AvatarDefinition, AvatarState } from 'open-bot-avatar';
import { mountAvatar, type MountedAvatar } from 'open-bot-avatar/dom';
import { POSES, type ExpressionId } from '@norbert_bodziony/bloub';
import {
  PlushBot,
  type PlushBotProps,
  type PlushShapeId,
  type PlushState,
} from '@norbert_bodziony/bloub/plush';
import { render } from '@solidjs/web';
import { createComponent, createSignal, flush } from 'solid-js';
import { useEffect, useRef, useState } from 'react';
import type { BotActivity } from '@/lib/botActivity';
import { uprightFace } from '@/lib/faces';
import {
  FACE_MS,
  gazeOf,
  HEAD_REST,
  headFor,
  headToward,
  lookTarget,
  pointerIn,
  pointerLook,
  sharedClock,
  swayAt,
  workingFaceAt,
  type HeadPose,
} from '@/lib/gaze';
import { objectDefinition } from '@/lib/object-avatars';
import { cn } from '@/lib/utils';

/** The plush body each shape is drawn with. Shapes no longer offered take the nearest one. */
const BODIES: Record<AvatarShape, PlushShapeId> = {
  blob: 'cercle',
  pebble: 'galet',
  squircle: 'squircle',
  capsule: 'capsule',
  drop: 'goutte',
  square: 'carre',
  diamond: 'losange',
  hexagon: 'hexagone',
  pentagon: 'pentagone',
  triangle: 'triangle',
  cloud: 'nuage',
  clover: 'nuage',
  star: 'pentagone',
  shield: 'pentagone',
  leaf: 'galet',
  bolt: 'triangle',
  moon: 'capsule',
};

/**
 * Resting eyes a bot can have; its id picks one, so each bot keeps its own look. Only upright ovals:
 * at avatar size slanted eyes, even a mirrored smile, read as crooked rather than as a mood.
 */
const RESTING: readonly ExpressionId[] = ['neutre', 'attentif', 'timide'];

/** Faces a working bot moves between, each fitting what it does. */
const WORK_FACES: Partial<Record<BotActivity, readonly ExpressionId[]>> = {
  thinking: ['attentif', 'neutre', 'surpris'],
  writing: ['attentif', 'excite', 'fier', 'heureux'],
  browsing: ['surpris', 'attentif', 'neutre'],
};

interface Mood {
  state: PlushState;
  /** Null keeps the resting eyes. */
  expression: ExpressionId | null;
  /** Moves on its own; a resting mood moves only when pointed at, or where it always moves. */
  busy: boolean;
}

/**
 * How each activity shows. The body is the bot's identity and keeps its shape; the eyes, the head's
 * turn and the plush's felt pieces act it out: eyes that look up and then read while it thinks or
 * runs its tools, wide eyes at a page, a felt dot when it needs someone, sleepy eyes while it waits
 * its turn. Thinking keeps the eyes rather than the engine's three felt dots: covered by the dots the
 * face went still for as long as a tool ran.
 */
const MOODS: Record<BotActivity, Mood> = {
  idle: { state: 'idle', expression: null, busy: false },
  queued: { state: 'idle', expression: 'somnolent', busy: false },
  thinking: { state: 'idle', expression: 'attentif', busy: true },
  writing: { state: 'idle', expression: 'excite', busy: true },
  browsing: { state: 'wide', expression: null, busy: true },
  waiting: { state: 'notify', expression: 'attentif', busy: false },
};

/** A bot that has just finished laughs, with its head going, for a moment. */
const CELEBRATING: Mood = { state: 'idle', expression: 'hilare', busy: true };

/** Activities that end in a finished piece of work; a bot that goes from one of them to rest is done. */
const WORKING: ReadonlySet<BotActivity> = new Set(['thinking', 'writing', 'browsing']);

/** How long a bot shows it is done: a few hops, then it rests. */
const CELEBRATE_MS = 4000;

/**
 * True for a moment after the bot finishes its work, while it shows it is done. Only the move from
 * working to rest counts: a bot that stops to ask someone, or was only queued, is not done yet.
 */
function useCelebration(activity: BotActivity) {
  const [previous, setPrevious] = useState(activity);
  const [celebrating, setCelebrating] = useState(false);
  if (previous !== activity) {
    setPrevious(activity);
    setCelebrating(WORKING.has(previous) && activity === 'idle');
  }
  useEffect(() => {
    if (!celebrating) return;
    const timer = window.setTimeout(() => setCelebrating(false), CELEBRATE_MS);
    return () => window.clearTimeout(timer);
  }, [celebrating]);
  return celebrating;
}

/** Frames per second: plenty at avatar size, and a list of avatars stays cheap. */
const FPS = 30;
/**
 * The plush is drawn with room around it for its felt pieces, so its body takes only about two thirds
 * of the drawing. Zoomed in, the body nearly fills the avatar's box and the pieces spill past it.
 */
const BODY_STYLE = { transform: 'scale(1.38)', width: '100%', height: '100%', overflow: 'visible' };
/** What must be pointed at for a resting avatar to move: the control it sits in, not only itself. */
const HOVER_GROUP = "[data-avatar-hover], button, a, [role='button'], [role='link'], [role='menuitem']";

/**
 * - `still`: a picture; it draws one moment and starts no clock.
 * - `hover`: rests until its row or button is pointed at; a busy activity moves anyway.
 * - `always`: moves while the window has focus: drifting eyes, blinks. For the one large avatar.
 */
export type AvatarMotion = 'still' | 'hover' | 'always';

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** The plush takes a hex colour; a CSS variable such as the brand colour is read from the page. */
function hexColor(color: string) {
  const m = /^var\((--[\w-]+)\)$/.exec(color.trim());
  if (!m) return color;
  return getComputedStyle(document.documentElement).getPropertyValue(m[1]!).trim() || BRAND_COLOR;
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

type Live = Pick<PlushBotProps, 'shape' | 'color' | 'state' | 'expression' | 'paused'>;

/**
 * A shape bot, drawn as a felt plush whose eyes act out what the bot is doing. Every avatar of one bot
 * (the list, the chat, the panel) looks, blinks and changes face at the same moment: they share one
 * gaze and read their face from the same clock.
 */
export function ShapeArt({
  shape,
  color,
  activity = 'idle',
  motion = 'still',
  seed,
}: {
  shape: AvatarShape;
  color: string;
  activity?: BotActivity;
  motion?: AvatarMotion;
  /** The bot's id: its resting eyes, and what ties its avatars together. */
  seed?: string;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const update = useRef<((v: Live) => void) | null>(null);
  const [pointed, setPointed] = useState(false);
  const [focused, setFocused] = useState(true);
  const [faceSlot, setFaceSlot] = useState(() => Math.floor((sharedClock() * 1000) / FACE_MS));
  const [gaze] = useState(() => gazeOf(seed, activity));
  const celebrating = useCelebration(activity);
  const mood = celebrating ? CELEBRATING : MOODS[activity];
  const key = seed ?? shape;
  const resting = RESTING[hash(key) % RESTING.length]!;
  const still = motion === 'still';
  const faces = WORK_FACES[activity];
  const cycling = mood.busy && !still && !!faces;
  // Read by the frame callback, which is set up once.
  const busy = useRef(mood.busy);
  useEffect(() => {
    busy.current = mood.busy;
  }, [mood.busy]);
  const head = useRef<{ pose: HeadPose; at: number | null }>({ pose: HEAD_REST, at: null });

  useEffect(() => gaze.setActivity(activity), [gaze, activity]);

  // Pointing at the row or button the avatar sits in wakes it, and its eyes follow the pointer.
  useEffect(() => {
    const el = host.current;
    if (still || !el) return;
    const target = el.closest<HTMLElement>(HOVER_GROUP) ?? el;
    const move = (e: PointerEvent) =>
      gaze.setPointer(
        pointerIn(e.clientX, e.clientY, el.getBoundingClientRect(), target.getBoundingClientRect()),
      );
    const enter = (e: PointerEvent) => {
      move(e);
      window.addEventListener('pointermove', move);
      setPointed(true);
    };
    const leave = () => {
      window.removeEventListener('pointermove', move);
      gaze.setPointer(null);
      setPointed(false);
    };
    target.addEventListener('pointerenter', enter);
    target.addEventListener('pointerleave', leave);
    return () => {
      target.removeEventListener('pointerenter', enter);
      target.removeEventListener('pointerleave', leave);
      window.removeEventListener('pointermove', move);
      gaze.setPointer(null);
    };
  }, [still, gaze]);

  // An avatar that moves as decoration rests while another app has the focus.
  useEffect(() => {
    if (motion !== 'always') return;
    const sync = () => setFocused(document.hasFocus());
    sync();
    window.addEventListener('focus', sync);
    window.addEventListener('blur', sync);
    return () => {
      window.removeEventListener('focus', sync);
      window.removeEventListener('blur', sync);
    };
  }, [motion]);

  // A working bot changes face on the shared clock, so all its avatars change at once.
  useEffect(() => {
    if (!cycling || reducedMotion()) return;
    let timer = 0;
    const next = () => {
      const ms = sharedClock() * 1000;
      timer = window.setTimeout(
        () => {
          setFaceSlot(Math.floor((sharedClock() * 1000) / FACE_MS));
          next();
        },
        FACE_MS - (ms % FACE_MS) + 5,
      );
    };
    next();
    return () => window.clearTimeout(timer);
  }, [cycling]);

  // Read when the props are handed over, never during render: the page's motion setting.
  const live = (): Live => {
    const calm = reducedMotion();
    const face = cycling && faces && !calm ? workingFaceAt(key, faces, faceSlot * FACE_MS) : null;
    const moving =
      (mood.busy && focused) || (motion === 'always' && focused) || (pointed && motion === 'hover');
    return {
      shape: BODIES[shape] ?? 'cercle',
      color: hexColor(color),
      state: mood.state,
      expression: uprightFace(face ?? mood.expression ?? resting),
      paused: calm || !moving,
    };
  };

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const [get, set] = createSignal<Live>(live());
    const dispose = render(
      () =>
        createComponent(PlushBot, {
          get shape() {
            return get().shape;
          },
          get color() {
            return get().color;
          },
          get state() {
            return get().state;
          },
          get expression() {
            return get().expression;
          },
          get paused() {
            return get().paused;
          },
          // A picture draws the resting pose and starts no clock.
          frozenAt: still ? POSES.idle : undefined,
          // The shared clock, not the avatar's own: its avatars look and blink together. The head
          // turns after the eyes on every frame the engine draws.
          gaze: still
            ? undefined
            : () => {
                const t = sharedClock();
                const look = gaze.look(t);
                const h = head.current;
                h.pose = headToward(h.pose, headFor(look, busy.current, t), h.at === null ? 0 : t - h.at);
                h.at = t;
                const { x, y, tilt } = h.pose;
                el.style.transition = '';
                el.style.transform = `translate(${(x * 100).toFixed(2)}%, ${(y * 100).toFixed(2)}%) rotate(${tilt.toFixed(2)}deg)`;
                return look;
              },
          // The engine stops an avatar that is off screen or in a hidden window.
          autoPause: true,
          eyeScale: 1,
          initialPhase: ((hash(seed ?? shape) % 1000) / 1000) * 1.4,
          transition: still ? 'cut' : 'pop',
          size: 100,
          fps: FPS,
          ariaLabel: '',
          style: BODY_STYLE,
        }),
      el,
    );
    flush();
    update.current = (v) => {
      set(v);
      flush();
    };
    return () => {
      update.current = null;
      dispose();
    };
    // Mounted once; later prop changes go through `update`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [still]);

  useEffect(() => {
    const v = live();
    update.current?.(v);
    // A stopped avatar's head eases back upright rather than staying turned where it stopped.
    const el = host.current;
    if (v.paused && el && head.current.at !== null) {
      head.current = { pose: HEAD_REST, at: null };
      el.style.transition = 'transform 0.4s ease-out';
      el.style.transform = '';
    }
  });

  return <span ref={host} className="block size-full" aria-hidden />;
}

/**
 * How each activity shows on an object avatar: ribbons sweeping round it while it writes or reads a
 * page, an exclamation mark when it needs someone, and a quiet wait while its turn has not come.
 * Thinking, which is also when it runs its tools, is not the engine's own: that one hides the body
 * behind three dots for as long as a tool runs. The bot keeps its face instead and is steered like the
 * plush, looking up to one side, then going over the page line by line, its head swaying all along.
 */
const OBJECT_STATES: Record<BotActivity, AvatarState> = {
  idle: 'idle',
  queued: 'waiting',
  thinking: 'idle',
  writing: 'working',
  browsing: 'working',
  waiting: 'blocked',
};

/** Radians an object avatar turns for each pixel it is dragged. */
const TURN_PER_PX = 0.012;
/** How far it tips up or down by hand: past this it would show its underside. */
const TIP_LIMIT = 1.1;
/** How long a let-go avatar takes to turn back to the person. */
const SETTLE_MS = 700;

/**
 * Lets a large object avatar be turned round by dragging it, as a thing in the hand: it follows the
 * pointer in 3D and, let go, turns back to face the person the short way round. A drag does not count
 * as a click on the button the avatar sits in.
 */
function useTurnByHand(
  host: React.RefObject<HTMLSpanElement | null>,
  avatar: React.RefObject<MountedAvatar | null>,
  on: boolean,
  /** What the avatar is drawn from: a new drawing mounts a new avatar to turn. */
  drawing: unknown,
) {
  useEffect(() => {
    const el = host.current;
    const mounted = avatar.current;
    if (!on || !el || !mounted) return;
    let view = { yaw: 0, pitch: 0 };
    let drag: { x: number; y: number; yaw: number; pitch: number; moved: boolean } | null = null;
    let settling = 0;
    const show = (next: typeof view, holding: boolean) => {
      view = next;
      mounted.update({ view: next, holdGaze: holding });
    };
    const swallow = (e: Event) => {
      e.stopPropagation();
      e.preventDefault();
    };
    const settle = () => {
      // The short way back: a few turns round count as none.
      const from = { yaw: Math.atan2(Math.sin(view.yaw), Math.cos(view.yaw)), pitch: view.pitch };
      const start = performance.now();
      const step = (now: number) => {
        const p = reducedMotion() ? 1 : Math.min(1, (now - start) / SETTLE_MS);
        const left = (1 - p) ** 3;
        show({ yaw: from.yaw * left, pitch: from.pitch * left }, false);
        if (p < 1) settling = requestAnimationFrame(step);
      };
      settling = requestAnimationFrame(step);
    };
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      cancelAnimationFrame(settling);
      drag = { x: e.clientX, y: e.clientY, yaw: view.yaw, pitch: view.pitch, moved: false };
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // A pointer the page no longer knows; the drag still works while it stays over the avatar.
      }
    };
    const move = (e: PointerEvent) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      show(
        {
          yaw: drag.yaw + dx * TURN_PER_PX,
          pitch: Math.min(TIP_LIMIT, Math.max(-TIP_LIMIT, drag.pitch - dy * TURN_PER_PX)),
        },
        true,
      );
    };
    const up = () => {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      if (!moved) return;
      el.addEventListener('click', swallow, { capture: true, once: true });
      // A drag that ends off the avatar brings no click to swallow.
      window.setTimeout(() => el.removeEventListener('click', swallow, { capture: true }), 0);
      settle();
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    return () => {
      cancelAnimationFrame(settling);
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      mounted.update({ view: { yaw: 0, pitch: 0 }, holdGaze: false });
    };
    // `drawing` stands for the avatar mounted from it.
  }, [host, avatar, on, drawing]);
}

/**
 * Points an object avatar's eyes and body at the pointer anywhere on the page, the way its engine's own
 * following does, but measured against the avatar's own size (see `pointerLook`). It hands the engine a
 * look on each pointer move, at most once a frame; the engine eases towards it. When the pointer leaves
 * the window the avatar goes back to its own idle looks.
 */
function useFollowPointer(
  host: React.RefObject<HTMLSpanElement | null>,
  avatar: React.RefObject<MountedAvatar | null>,
  on: boolean,
  drawing: AvatarDefinition | undefined,
) {
  useEffect(() => {
    const el = host.current;
    const mounted = avatar.current;
    if (!on || !el || !mounted || !drawing) return;
    const eyes = { x: drawing.eyes.x / 100, y: drawing.eyes.y / 100 };
    let pointer: { x: number; y: number } | null = null;
    let frame = 0;
    const aim = () => {
      frame = 0;
      if (!pointer) return;
      mounted.update({ lookAt: pointerLook(pointer, el.getBoundingClientRect(), eyes) });
    };
    const move = (e: PointerEvent) => {
      pointer = { x: e.clientX, y: e.clientY };
      if (!frame) frame = requestAnimationFrame(aim);
    };
    const leave = () => {
      pointer = null;
      mounted.update({ lookAt: null });
    };
    // Leaving the window shows up as an `out` with no related target.
    const out = (e: PointerEvent) => {
      if (!e.relatedTarget) leave();
    };
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('pointerdown', move, { passive: true });
    window.addEventListener('pointerout', out);
    window.addEventListener('blur', leave);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerdown', move);
      window.removeEventListener('pointerout', out);
      window.removeEventListener('blur', leave);
      mounted.update({ lookAt: null });
    };
  }, [host, avatar, on, drawing]);
}

/** White eyes, as the plush has: on a coloured body they read as a face rather than as holes. */
const OBJECT_EYES = '#ffffff';

/**
 * An object bot (a mug, a lightbulb with eyes), drawn with volume. Unlike the plush it does not wait
 * to be pointed at: while the window has the focus it breathes, blinks and looks at the pointer
 * wherever it is on the page, which is what makes these avatars feel alive. The engine itself stops
 * one that is off screen and follows the system's reduced motion setting; `still` draws one picture.
 */
export function ObjectArt({
  id,
  color,
  activity = 'idle',
  motion = 'still',
  seed,
  turnable = false,
}: {
  id: ObjectAvatar;
  color: string;
  activity?: BotActivity;
  motion?: AvatarMotion;
  /** The bot's id: its avatars share one gaze, so they look the same way at once. */
  seed?: string;
  /** Can be turned round by dragging it; for a large avatar. */
  turnable?: boolean;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const avatar = useRef<MountedAvatar | null>(null);
  const [focused, setFocused] = useState(true);
  const [gaze] = useState(() => gazeOf(seed, activity));
  const moving = motion !== 'still' && focused;
  const definition = objectDefinition(id);
  const steered = moving && activity === 'thinking';
  const celebrating = useCelebration(activity);
  const turning = turnable && moving && !steered;

  useEffect(() => gaze.setActivity(activity), [gaze, activity]);

  // It rests while another app has the focus.
  useEffect(() => {
    if (motion === 'still') return;
    const sync = () => setFocused(document.hasFocus());
    sync();
    window.addEventListener('focus', sync);
    window.addEventListener('blur', sync);
    return () => {
      window.removeEventListener('focus', sync);
      window.removeEventListener('blur', sync);
    };
  }, [motion]);

  useEffect(() => {
    const el = host.current;
    if (!el || !definition) return;
    avatar.current = mountAvatar(el, { definition, eyeColor: OBJECT_EYES, label: '' });
    return () => {
      avatar.current?.destroy();
      avatar.current = null;
    };
  }, [definition]);

  // After the mount above, so the avatar it turns is there.
  useTurnByHand(host, avatar, turning, definition);
  useFollowPointer(host, avatar, moving && !steered, definition);

  useEffect(() => {
    avatar.current?.update({
      color: hexColor(color),
      eyeColor: OBJECT_EYES,
      // Just done: it smiles with its eyes and hops, the engine's happy mood at rest, then rests.
      // The engine's own `done` turns it round with ribbons flying, more than a finished task asks.
      state: celebrating ? 'idle' : OBJECT_STATES[activity],
      mood: celebrating ? 'happy' : 'neutral',
      still: !moving,
      // Followed by `useFollowPointer`, which reaches further for a small avatar.
      followPointer: false,
    });
  });

  // A thinking bot's look and sway, frame by frame, from the gaze its other avatars share.
  useEffect(() => {
    if (!steered || reducedMotion()) return;
    let frame = 0;
    const step = () => {
      const t = sharedClock();
      avatar.current?.update({ lookAt: lookTarget(gaze.look(t)), view: swayAt(t) });
      frame = requestAnimationFrame(step);
    };
    step();
    return () => {
      cancelAnimationFrame(frame);
      avatar.current?.update({ lookAt: null, view: { yaw: 0, pitch: 0 } });
    };
  }, [steered, gaze]);

  return (
    <span
      ref={host}
      className={cn('block size-full', turning && 'cursor-grab touch-none active:cursor-grabbing')}
      aria-hidden
    />
  );
}

export function BotAvatar({
  avatar,
  color,
  size = 40,
  className,
  badge,
  activity,
  motion = 'hover',
  seed,
}: {
  avatar: string;
  color: string;
  size?: number;
  className?: string;
  badge?: React.ReactNode;
  /** Animates the avatar; leave out where the avatar only identifies the bot. */
  activity?: BotActivity;
  /** How an animated avatar moves; see `AvatarMotion`. */
  motion?: Exclude<AvatarMotion, 'still'>;
  /** The bot's id, which picks its resting eyes. */
  seed?: string;
}) {
  const lively = activity !== undefined;
  const isImage = avatar.startsWith('data:image/');
  return (
    <span className={cn('relative inline-flex shrink-0', className)} style={{ width: size, height: size }}>
      {isImage ? (
        <img
          src={avatar}
          alt=""
          className={cn(
            'av-img size-full rounded-full object-cover',
            activity && activity !== 'idle' && `av-${activity}`,
          )}
          draggable={false}
        />
      ) : avatar.startsWith('object:') ? (
        <ObjectArt
          id={avatar.slice(7) as ObjectAvatar}
          color={color}
          activity={activity}
          motion={lively ? motion : 'still'}
          seed={seed}
          turnable={lively && motion === 'always'}
        />
      ) : (
        <ShapeArt
          shape={avatar.slice(6) as AvatarShape}
          color={color}
          activity={activity}
          motion={lively ? motion : 'still'}
          seed={seed}
        />
      )}
      {badge}
    </span>
  );
}
