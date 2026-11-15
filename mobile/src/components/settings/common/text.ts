import type { T } from '@/i18n';

/** YumakBot's own tools, under the server name every engine gives them. */
const OWN = 'yumakbot';

/**
 * A permission rule as a person reads it. A connection's tool is named by its service and tool
 * (`mcp__service__create_page` becomes a service name and the tool), and YumakBot's own tools lose
 * the server prefix. Null when the pattern reads plainly as it is.
 */
export function ruleLabel(pattern: string, t: T, apps: ReadonlyMap<string, string>): string | null {
  const m = /^mcp__([a-z0-9_]+?)__([^()]+?)(?:\((.*)\))?$/s.exec(pattern.trim());
  if (!m) return null;
  const [, server, tool, args] = m as unknown as [string, string, string, string | undefined];
  const scope = args !== undefined ? ` (${args})` : '';
  if (server === OWN) return `${tool}${scope}`;
  const app = apps.get(server) ?? server;
  if (tool === '*') return `${t('rules.appAllTools', { app })}${scope}`;
  return `${t('rules.appTool', { app, tool })}${scope}`;
}

/** A short name for the device a user agent string belongs to, such as an app and an OS. */
export function deviceName(ua: string | null): { app: string | null; os: string | null } {
  if (!ua) return { app: null, os: null };
  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X|Macintosh/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /CrOS/.test(ua)
            ? 'ChromeOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : null;
  // The desktop app's window is Electron and the phone app adds its own mark; both are checked
  // first, as they also say Chrome or Safari.
  const app = /Electron\/|YumakBotMobile\//.test(ua)
    ? 'YumakBot'
    : /Edg\//.test(ua)
      ? 'Edge'
      : /OPR\//.test(ua)
        ? 'Opera'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Chrome\/|CriOS\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : null;
  return { app, os };
}
