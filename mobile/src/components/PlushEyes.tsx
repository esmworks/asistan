import { activityOf, type BotActivity } from '@leafbot/app/src/lib/activity';
import { gazeOf, sharedClock } from '@leafbot/app/src/lib/gaze';
import { useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, Animated, AppState, type StyleProp, type ViewStyle } from 'react-native';
import { eyeShift } from '@/lib/eyes';
import { useSummaries } from '@/lib/queries';
import { useLiveState, useStream } from '@/lib/realtime';

/**
 * - `always`: looks around and blinks while the app is open. For the bot's large avatars.
 * - `busy`: rests until the bot is at work. For lists, where the web moves an avatar on hover.
 */
export type EyeMotion = 'always' | 'busy';

/** Frames per second: plenty at avatar size, and a screen of avatars stays cheap. */
const FPS = 30;
/** A shut lid keeps a sliver of the eye, so a blink reads as a blink and not as the eyes vanishing. */
const SHUT = 0.08;

/** One clock for every moving avatar, running only while one is on screen. */
const ticks = new Set<() => void>();
let frame = 0;
let lastTick = 0;

function loop(now: number) {
  frame = requestAnimationFrame(loop);
  if (now - lastTick < 1000 / FPS - 2) return;
  lastTick = now;
  for (const tick of ticks) tick();
}

function onTick(tick: () => void) {
  ticks.add(tick);
  if (ticks.size === 1) frame = requestAnimationFrame(loop);
  return () => {
    ticks.delete(tick);
    if (!ticks.size) cancelAnimationFrame(frame);
  };
}

/** Whether the app is in front; a moving avatar rests while it is not. */
function useAppActive() {
  const [active, setActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setActive(s === 'active'));
    return () => sub.remove();
  }, []);
  return active;
}

/** The phone's Reduce Motion setting; with it on the eyes hold still. */
function useReduceMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((on) => live && setReduce(on));
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
  return reduce;
}

/** What a bot is doing in the conversation it opens to, the same for each of its avatars. */
function useBotActivity(botId: string | undefined): BotActivity {
  const summary = useSummaries().data?.find((s) => s.botId === botId);
  const threadId = summary?.threadId ?? undefined;
  const live = useLiveState(threadId);
  const stream = useStream(threadId);
  return activityOf({
    state: live ?? summary?.state ?? 'idle',
    pendingApprovals: summary?.pendingApprovals ?? 0,
    streaming: !!stream,
    // The phone does not follow the bot's browser; a turn that browses shows as thinking.
    browsing: false,
  });
}

type EyesProps = {
  /** The bot's id, which ties its avatars together. */
  seed: string | undefined;
  /** What the bot is doing; left out, a bot's is read from its conversation. */
  activity?: BotActivity;
  motion: EyeMotion;
  /** The size of the body picture, which the eyes' steps are measured in. */
  span: number;
  eye: StyleProp<ViewStyle>;
  left: ViewStyle;
  right: ViewStyle;
};

/**
 * The two eyes of a plush avatar, moving as the web app moves them: they hold a look, jump to the next
 * one the bot's activity calls for, and blink. Every avatar of one bot shares one gaze, so they look
 * and blink together. The app's own mascot is no bot: it shows before a server is chosen, so it reads
 * nothing from one.
 */
export function PlushEyes(props: EyesProps) {
  return props.seed ? <BotEyes {...props} /> : <Eyes {...props} activity={props.activity ?? 'idle'} />;
}

function BotEyes(props: EyesProps) {
  const own = useBotActivity(props.seed);
  return <Eyes {...props} activity={props.activity ?? own} />;
}

function Eyes({ seed, activity, motion, span, eye, left, right }: EyesProps & { activity: BotActivity }) {
  const [gaze] = useState(() => gazeOf(seed, activity));
  const active = useAppActive();
  const reduce = useReduceMotion();
  const moving = active && !reduce && (motion === 'always' || activity !== 'idle');

  const values = useMemo(
    () => ({ x: new Animated.Value(0), y: new Animated.Value(0), lid: new Animated.Value(1) }),
    [],
  );

  useEffect(() => gaze.setActivity(activity), [gaze, activity]);

  useEffect(() => {
    if (!moving) {
      // At rest the eyes look at the person, open.
      values.x.setValue(0);
      values.y.setValue(0);
      values.lid.setValue(1);
      return;
    }
    return onTick(() => {
      const look = gaze.look(sharedClock());
      const at = eyeShift(look, span);
      values.x.setValue(at.x);
      values.y.setValue(at.y);
      values.lid.setValue(Math.max(SHUT, look.lid));
    });
  }, [moving, gaze, span, values]);

  const transform = [{ translateX: values.x }, { translateY: values.y }, { scaleY: values.lid }];
  return (
    <>
      <Animated.View style={[eye, left, { transform }]} />
      <Animated.View style={[eye, right, { transform }]} />
    </>
  );
}
