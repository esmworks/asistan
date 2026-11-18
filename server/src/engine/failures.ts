/** How many times in a row the same call may fail the same way before the bot is told to stop. */
export const FAILURE_STREAK = 3;

/**
 * How many times in a row it may fail before the turn is stopped. A bot that keeps going after
 * being told spends the person's tokens on an answer that will not change.
 */
export const FAILURE_STOP = 5;

/**
 * Counts the same tool call failing the same way back to back, and says so to the bot once that
 * happens {@link FAILURE_STREAK} times: a model retrying an unchanged call rarely gets another
 * answer. At {@link FAILURE_STOP} `onStop` is called once, for the turn to be ended. A call that
 * works, or a different call, starts the count again; a poll that keeps succeeding with the same
 * output is never counted.
 */
export function failureStreak(onStop?: (toolName: string, count: number) => void) {
  let last = '';
  let count = 0;
  let stopped = false;
  return {
    reset() {
      last = '';
      count = 0;
    },
    note(toolName: string, toolInput: unknown, error: string): string | null {
      const key = JSON.stringify([toolName, toolInput, error.slice(0, 2000)]);
      count = key === last ? count + 1 : 1;
      last = key;
      if (count >= FAILURE_STOP && !stopped) {
        stopped = true;
        onStop?.(toolName, count);
      }
      if (count < FAILURE_STREAK) return null;
      return `This call has failed the same way ${count} times in a row. Do not run it again unchanged: change the approach, or tell the person what is in the way.`;
    },
  };
}
