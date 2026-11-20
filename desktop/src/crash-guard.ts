/** Why a renderer ended; `clean-exit` is a normal close, not a crash. */
export type GoneReason =
  'clean-exit' | 'abnormal-exit' | 'killed' | 'crashed' | 'oom' | 'launch-failed' | 'integrity-failure';

export const MAX_CRASHES = 3;
export const CRASH_WINDOW_MS = 60_000;

/** Whether the reason means the page died, so it is worth reloading. */
export function isCrash(reason: string): boolean {
  return reason !== 'clean-exit';
}

/**
 * Decides what to do after a crash: reload at first, but a page that keeps dying within a short
 * time would reload forever, so after `MAX_CRASHES` in `CRASH_WINDOW_MS` the person chooses.
 */
export function createCrashGuard(now: () => number = Date.now) {
  let times: number[] = [];
  return {
    record(): 'reload' | 'ask' {
      const at = now();
      times = times.filter((t) => at - t < CRASH_WINDOW_MS);
      times.push(at);
      if (times.length < MAX_CRASHES) return 'reload';
      times = [];
      return 'ask';
    },
  };
}
