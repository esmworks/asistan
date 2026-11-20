import { describe, expect, it } from 'vitest';
import { CRASH_WINDOW_MS, MAX_CRASHES, createCrashGuard, isCrash } from './crash-guard';

describe('renderer crash guard', () => {
  it('does not treat a clean exit as a crash', () => {
    expect(isCrash('clean-exit')).toBe(false);
    expect(isCrash('crashed')).toBe(true);
    expect(isCrash('oom')).toBe(true);
  });

  it('reloads at first and asks once crashes repeat within the window', () => {
    let clock = 0;
    const guard = createCrashGuard(() => clock);
    const results: string[] = [];
    for (let i = 0; i < MAX_CRASHES; i++) {
      results.push(guard.record());
      clock += 1000;
    }
    expect(results).toEqual(['reload', 'reload', 'ask']);
    // After the person chose, counting starts over.
    expect(guard.record()).toBe('reload');
  });

  it('forgets crashes that are far apart', () => {
    let clock = 0;
    const guard = createCrashGuard(() => clock);
    for (let i = 0; i < 10; i++) {
      expect(guard.record()).toBe('reload');
      clock += CRASH_WINDOW_MS + 1;
    }
  });
});
