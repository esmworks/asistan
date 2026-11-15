/** A short name for the device a user agent string belongs to: "Chrome on macOS", "YumakBot on Windows". */
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
  // The desktop app's window is Electron, checked first as it also says Chrome.
  const app = /Electron\//.test(ua)
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
