import { describe, expect, it } from 'vitest';
import { adoptOldEnv } from './old-names';

describe('settings under the name before the rename', () => {
  it('reads an old name where the new one is missing, and leaves a new one as it is', () => {
    const env: Record<string, string | undefined> = {
      YUMAKBOT_PORT: '5000',
      YUMAKBOT_ACCESS_KEY: 'old',
      LEAFBOT_ACCESS_KEY: 'new',
      PATH: '/bin',
    };
    adoptOldEnv(env);
    expect(env).toEqual({
      YUMAKBOT_PORT: '5000',
      LEAFBOT_PORT: '5000',
      YUMAKBOT_ACCESS_KEY: 'old',
      LEAFBOT_ACCESS_KEY: 'new',
      PATH: '/bin',
    });
  });
});
