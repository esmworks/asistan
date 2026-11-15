import type { BrowserManager } from './browser/manager';
import type { Bus } from './bus';
import type { ComputerService } from './computer/service';
import type { Config } from './config';
import type { Db } from './db';

export interface Ctx {
  db: Db;
  bus: Bus;
  config: Config;
  /** The bots' browsers; `available` is false when no browser program was found. */
  browser: BrowserManager;
  /** The bots' desktops; null when no computer service is configured. */
  computer: ComputerService | null;
}
