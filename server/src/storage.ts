import { lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { inArray } from 'drizzle-orm';
import {
  STORAGE_TOP_THREADS,
  type StorageBot,
  type StorageFolder,
  type StorageGroup,
  type StorageReport,
  type StorageSize,
} from '@leafbot/shared';
import type { Ctx } from './context';
import { schema } from './db';

/**
 * The most files and folders one report looks at. A bot's folder can hold a cloned repository or
 * a build with hundreds of thousands of files; past this the sizes are given as "at least".
 */
export const STORAGE_MAX_ENTRIES = 200_000;
/** How many sizes are read at once in one folder. */
const BATCH = 64;

/** Adds up folder sizes, sharing one budget of entries across the whole report. */
export class SizeWalk {
  private seen = 0;
  capped = false;
  constructor(private max = STORAGE_MAX_ENTRIES) {}

  /**
   * Bytes and files under `dir`. Links are not followed and count as nothing: they may point
   * anywhere, and what they point to is counted where it lives, if it is in a bot's folder.
   */
  async size(dir: string): Promise<StorageSize> {
    const total: StorageSize = { bytes: 0, files: 0 };
    await this.add(dir, total);
    return total;
  }

  /** {@link size} with whether the budget ran out in the folder or before it. */
  async folder(dir: string): Promise<StorageFolder> {
    const size = await this.size(dir);
    return { ...size, partial: this.capped };
  }

  private async add(dir: string, total: StorageSize): Promise<void> {
    if (this.capped) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const files: string[] = [];
    const dirs: string[] = [];
    for (const e of entries) {
      if (++this.seen > this.max) {
        this.capped = true;
        break;
      }
      if (e.isDirectory()) dirs.push(join(dir, e.name));
      else if (e.isFile()) files.push(join(dir, e.name));
    }
    for (let i = 0; i < files.length; i += BATCH) {
      const sizes = await Promise.all(
        files.slice(i, i + BATCH).map((f) =>
          lstat(f).then(
            (st) => (st.isFile() ? st.size : null),
            () => null,
          ),
        ),
      );
      for (const s of sizes) {
        if (s === null) continue;
        total.bytes += s;
        total.files++;
      }
    }
    for (const d of dirs) await this.add(d, total);
  }
}

/** The folders in `dir` (no links), or none when it is not there. */
async function folders(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

const plus = (a: StorageSize, b: StorageSize): StorageSize => ({
  bytes: a.bytes + b.bytes,
  files: a.files + b.files,
});

/**
 * What the bots' folders, the groups' shared folders and the waiting attachments take on disk,
 * read fresh each time. Nothing is removed here: a conversation's folder holds the bot's own work
 * next to what was attached, so freeing room is done by deleting the conversation.
 */
export async function storageReport(ctx: Ctx, max = STORAGE_MAX_ENTRIES): Promise<StorageReport> {
  const root = resolve(ctx.config.dataDir, 'workspaces');
  const walk = new SizeWalk(max);

  const bots: StorageBot[] = [];
  for (const botId of await folders(join(root, 'bots'))) {
    const own = await walk.folder(join(root, 'bots', botId, 'files'));
    const threadsDir = join(root, 'bots', botId, 'threads');
    const threads = [];
    for (const threadId of await folders(threadsDir)) {
      threads.push({
        threadId,
        title: null as string | null,
        ...(await walk.folder(join(threadsDir, threadId))),
      });
    }
    // Anything else the bot keeps beside those two folders.
    let rest: StorageSize = { bytes: 0, files: 0 };
    for (const name of await folders(join(root, 'bots', botId))) {
      if (name !== 'files' && name !== 'threads')
        rest = plus(rest, await walk.size(join(root, 'bots', botId, name)));
    }
    const sum = threads.reduce<StorageSize>((acc, t) => plus(acc, t), plus(own, rest));
    threads.sort((a, b) => b.bytes - a.bytes);
    bots.push({
      botId,
      name: null,
      archived: false,
      ...sum,
      // The bot as a whole is "at least" when the walk ran out anywhere in it or before it; each
      // of its folders above says so only for itself.
      partial: walk.capped,
      own,
      threadCount: threads.length,
      threads: threads.slice(0, STORAGE_TOP_THREADS).filter((t) => t.bytes > 0),
    });
  }

  const groups: StorageGroup[] = [];
  for (const groupId of await folders(join(root, 'groups'))) {
    groups.push({ groupId, name: null, ...(await walk.folder(join(root, 'groups', groupId))) });
  }

  const staged = await walk.folder(join(ctx.config.dataDir, 'uploads'));

  // Names come from the database; a folder whose bot, group or conversation is gone keeps null.
  const botIds = bots.map((b) => b.botId);
  if (botIds.length) {
    const rows = await ctx.db
      .select({ id: schema.bots.id, name: schema.bots.name, archivedAt: schema.bots.archivedAt })
      .from(schema.bots)
      .where(inArray(schema.bots.id, botIds));
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const b of bots) {
      const row = byId.get(b.botId);
      b.name = row?.name ?? null;
      b.archived = !!row?.archivedAt;
    }
  }
  const threadIds = bots.flatMap((b) => b.threads.map((t) => t.threadId));
  if (threadIds.length) {
    const rows = await ctx.db
      .select({ id: schema.threads.id, title: schema.threads.title })
      .from(schema.threads)
      .where(inArray(schema.threads.id, threadIds));
    const byId = new Map(rows.map((r) => [r.id, r.title]));
    for (const b of bots) for (const t of b.threads) t.title = byId.get(t.threadId) ?? null;
  }
  const groupIds = groups.map((g) => g.groupId);
  if (groupIds.length) {
    const rows = await ctx.db
      .select({ id: schema.groups.id, name: schema.groups.name })
      .from(schema.groups)
      .where(inArray(schema.groups.id, groupIds));
    const byId = new Map(rows.map((r) => [r.id, r.name]));
    for (const g of groups) g.name = byId.get(g.groupId) ?? null;
  }

  bots.sort((a, b) => b.bytes - a.bytes);
  groups.sort((a, b) => b.bytes - a.bytes);
  const total = [...bots, ...groups, staged].reduce((n, x) => n + x.bytes, 0);
  return { total, capped: walk.capped, bots, groups, staged };
}
