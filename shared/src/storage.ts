/** Bytes and files in one folder and everything under it. */
export interface StorageSize {
  bytes: number;
  files: number;
}

/**
 * A folder the report sizes on its own. `partial` when the walk ran out of its budget in it or
 * before it: the size is then at least what it says, and may be far more.
 */
export interface StorageFolder extends StorageSize {
  partial: boolean;
}

/** A conversation's folder: what was attached there and what the bot made there. */
export interface StorageThread extends StorageFolder {
  threadId: string;
  /** Empty when the conversation has no title yet; null when it is gone but its folder is not. */
  title: string | null;
}

export interface StorageBot extends StorageFolder {
  botId: string;
  /** Null for a folder left by a bot that no longer exists. */
  name: string | null;
  archived: boolean;
  /** The bot's own permanent folder. */
  own: StorageFolder;
  /** How many conversation folders it has. */
  threadCount: number;
  /** Its largest conversation folders, largest first. */
  threads: StorageThread[];
}

export interface StorageGroup extends StorageFolder {
  groupId: string;
  name: string | null;
}

/**
 * How much room the bots' folders and the files waiting to be sent take on the server. When
 * `capped`, the walk stopped early: the folders marked `partial` are at least what they say.
 */
export interface StorageReport {
  total: number;
  capped: boolean;
  bots: StorageBot[];
  groups: StorageGroup[];
  /** Files attached in a message box and not sent yet. */
  staged: StorageFolder;
}

/** How many of a bot's largest conversations the report names. */
export const STORAGE_TOP_THREADS = 5;
