import { BRAND_COLOR, type AvatarShape, type ObjectAvatar } from '@leafbot/shared';
import { getExample, type AvatarState } from 'open-bot-avatar';
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
import { FACE_MS, gazeOf, pointerIn, sharedClock, workingFaceAt } from '@/lib/gaze';
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
 * How each activity shows. The body is the bot's identity and keeps still; the eyes and the plush's
 * felt pieces act it out: three felt dots while it thinks, wide eyes at a page, a felt dot when it
 * needs someone, sleepy eyes while it waits its turn.
 */
const MOODS: Record<BotActivity, Mood> = {
  idle: { state: 'idle', expression: null, busy: false },
  queued: { state: 'idle', expression: 'somnolent', busy: false },
  thinking: { state: 'thinking', expression: 'attentif', busy: true },
  writing: { state: 'idle', expression: 'excite', busy: true },
  browsing: { state: 'wide', expression: null, busy: true },
  waiting: { state: 'notify', expression: 'attentif', busy: false },
};

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
  const mood = MOODS[activity];
  const key = seed ?? shape;
  const resting = RESTING[hash(key) % RESTING.length]!;
  const still = motion === 'still';
  const faces = WORK_FACES[activity];
  const cycling = mood.busy && !still && !!faces;

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
          // The shared clock, not the avatar's own: its avatars look and blink together.
          gaze: still ? undefined : () => gaze.look(sharedClock()),
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
    update.current?.(live());
  });

  return <span ref={host} className="block size-full" aria-hidden />;
}

/**
 * How each activity shows on an object avatar. The engine's own states fit what the bot does: three
 * dots while it thinks, ribbons sweeping round it while it writes or reads a page, an exclamation
 * mark when it needs someone, and a quiet wait while its turn has not come.
 */
const OBJECT_STATES: Record<BotActivity, AvatarState> = {
  idle: 'idle',
  queued: 'waiting',
  thinking: 'thinking',
  writing: 'working',
  browsing: 'working',
  waiting: 'blocked',
};

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
}: {
  id: ObjectAvatar;
  color: string;
  activity?: BotActivity;
  motion?: AvatarMotion;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const avatar = useRef<MountedAvatar | null>(null);
  const [focused, setFocused] = useState(true);
  const moving = motion !== 'still' && focused;
  const definition = getExample(id);

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
    avatar.current = mountAvatar(el, { definition, label: '' });
    return () => {
      avatar.current?.destroy();
      avatar.current = null;
    };
  }, [definition]);

  useEffect(() => {
    avatar.current?.update({
      color: hexColor(color),
      state: OBJECT_STATES[activity],
      still: !moving,
      followPointer: moving,
    });
  });

  return <span ref={host} className="block size-full" aria-hidden />;
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
