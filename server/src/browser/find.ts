import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';

/**
 * The browser program for the bots: `LEAFBOT_BROWSER` if set, else an installed Chrome, Edge or
 * Chromium in its usual place. Each bot gets its own profile, so the person's own browser profile
 * is never touched.
 */
export function findBrowser(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): string | null {
  if (env.LEAFBOT_BROWSER) return exists(env.LEAFBOT_BROWSER) ? env.LEAFBOT_BROWSER : null;
  return candidates(env, platform).find(exists) ?? null;
}

function candidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(
      (r): r is string => !!r,
    );
    return [
      ...roots.map((r) => win32.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe')),
      ...roots.map((r) => win32.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
    ];
  }
  if (platform === 'darwin') {
    const apps = ['/Applications', ...(env.HOME ? [posix.join(env.HOME, 'Applications')] : [])];
    return apps.flatMap((a) => [
      posix.join(a, 'Google Chrome.app/Contents/MacOS/Google Chrome'),
      posix.join(a, 'Chromium.app/Contents/MacOS/Chromium'),
      posix.join(a, 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
    ]);
  }
  return [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/microsoft-edge',
    '/snap/bin/chromium',
  ];
}
