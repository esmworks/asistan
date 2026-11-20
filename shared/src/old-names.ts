/**
 * The app was called Yumak Bot before Leaf Bot. Installations set up then keep their settings under
 * the old names (`YUMAKBOT_PORT` in a Docker `.env`, a service file, a shell profile), so each
 * process reads an old name wherever the new one is not set. Values are copied, never moved: a
 * child process started with this environment sees both.
 */
export const OLD_ENV_PREFIX = 'YUMAKBOT_';
export const ENV_PREFIX = 'LEAFBOT_';

export function adoptOldEnv(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(OLD_ENV_PREFIX) || value === undefined) continue;
    const renamed = ENV_PREFIX + key.slice(OLD_ENV_PREFIX.length);
    if (env[renamed] === undefined) env[renamed] = value;
  }
}
