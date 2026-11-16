/** How often a running app looks for a new release after the check at start. */
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/** The part of electron-updater's `autoUpdater` used here, so a test can stand in for it. */
export interface Updater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: 'update-downloaded', listener: (info: { version: string }) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface UpdateOptions {
  updater: Updater;
  /** Asks whether to restart into the downloaded version now. */
  ask: (version: string) => Promise<boolean>;
  /** Stops what the app runs (the server) so the installer finds nothing holding its files. */
  beforeInstall: () => Promise<void>;
  /** A version is downloaded and waits to be installed, so the menu can offer it. */
  onReady: (version: string) => void;
  warn: (message: string) => void;
  everyMs?: number;
}

export interface Updates {
  /** Stops the server and restarts into the downloaded version. */
  install(): Promise<void>;
  stop(): void;
}

/**
 * Updates from the GitHub releases named by electron-builder's `publish` setting. A new version
 * downloads in the background; the person is asked once whether to restart into it, and a version
 * left waiting installs when the app quits. Once one is waiting there is nothing more to look for
 * until the restart, so the periodic checks stop asking.
 */
export function startUpdates(options: UpdateOptions): Updates {
  const { updater, everyMs = CHECK_EVERY_MS } = options;
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;

  let ready: string | null = null;
  let installing = false;

  const install = async () => {
    if (!ready || installing) return;
    installing = true;
    try {
      await options.beforeInstall();
    } finally {
      // Silent, so the Windows installer does not walk the person through its pages again, and
      // started again afterwards, as "restart" promises.
      updater.quitAndInstall(true, true);
    }
  };

  updater.on('update-downloaded', (info) => {
    if (ready === info.version) return;
    ready = info.version;
    options.onReady(info.version);
    void options.ask(info.version).then((now) => (now ? install() : undefined));
  });
  // A failed check (offline, GitHub unreachable, an unsigned Mac build) is tried again later.
  updater.on('error', (error) => options.warn(`update check failed: ${error.message}`));

  const check = () => {
    if (ready) return;
    updater.checkForUpdates().catch(() => undefined);
  };
  check();
  const timer = setInterval(check, everyMs);
  timer.unref?.();

  return { install, stop: () => clearInterval(timer) };
}
