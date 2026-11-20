import { mkdir, readdir, rename, stat, statfs } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { DoctorCheck, DoctorCheckId, DoctorReport } from '@leafbot/shared';
import { and, eq, inArray, lt, notInArray } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import { WHATSAPP_DRAFT_TOOLS } from './approvals';
import type { Services } from './index';

/**
 * How long a turn or a card must have stood before the check calls it left behind: a turn is
 * marked running a moment before this server starts running it.
 */
const GRACE_MS = 2 * 60_000;
/** Free space under which the data folder is short of room, and under which it is about to fill. */
const DISK_LOW = 2 * 1024 ** 3;
const DISK_CRITICAL = 300 * 1024 ** 2;
/** The most entries a folder's size is counted over; a bigger one is shown as at least that. */
const SIZE_ENTRIES = 20_000;

/** A folder of the data folder that nothing in the database owns any more. */
interface Stray {
  path: string;
  bytes: number;
}

async function folders(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function size(dir: string): Promise<number> {
  let total = 0;
  let seen = 0;
  const walk = async (d: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++seen > SIZE_ENTRIES) return;
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) total += (await stat(p).catch(() => null))?.size ?? 0;
    }
  };
  await walk(dir);
  return total;
}

/**
 * The server's own check of its data: what a crash, a failed step or a full disk can leave wrong,
 * and the repairs that lose nothing. A turn or card left behind is ended as a restart would end
 * it; a folder whose bot, conversation or group is gone is moved aside into `doctor-trash`, never
 * deleted, so the person can look at it and remove it themselves. What cannot be mended safely
 * (content sealed with another key, a filling disk) is only reported.
 */
export class DoctorService {
  constructor(
    private ctx: Ctx,
    private services: Services,
  ) {}

  private get dataDir() {
    return this.ctx.config.dataDir;
  }

  private async stuckTurns(): Promise<string[]> {
    const live = this.services.turns.liveTurnIds();
    const rows = await this.ctx.db
      .select({ id: schema.turns.id })
      .from(schema.turns)
      .where(
        and(eq(schema.turns.status, 'running'), lt(schema.turns.startedAt, new Date(Date.now() - GRACE_MS))),
      );
    return rows.map((r) => r.id).filter((id) => !live.has(id));
  }

  /** Cards still waiting on a turn that no longer runs: nobody will read their answer. */
  private async staleApprovals(): Promise<string[]> {
    const live = this.services.turns.liveTurnIds();
    const rows = await this.ctx.db
      .select({ id: schema.approvals.id, turnId: schema.approvals.turnId })
      .from(schema.approvals)
      .where(
        and(
          eq(schema.approvals.status, 'pending'),
          // A WhatsApp draft waits for the person on its own, with no turn behind it.
          notInArray(schema.approvals.toolName, [...WHATSAPP_DRAFT_TOOLS]),
          lt(schema.approvals.createdAt, new Date(Date.now() - GRACE_MS)),
        ),
      );
    return rows.filter((r) => r.turnId && !live.has(r.turnId)).map((r) => r.id);
  }

  /** Folders of bots, conversations and groups the database no longer has. */
  private async strayFolders(): Promise<Stray[]> {
    // The folders are listed before the database is read: one made for a bot or conversation that
    // is created in between then has its row by the time it is looked up.
    const root = join(this.dataDir, 'workspaces');
    const botDirs = await folders(join(root, 'bots'));
    const threadDirs = await Promise.all(
      botDirs.map(async (bot) => ({ bot, threads: await folders(join(root, 'bots', bot, 'threads')) })),
    );
    const groupDirs = await folders(join(root, 'groups'));
    const browserDirs = await folders(join(this.dataDir, 'browsers'));
    const ids = async (table: typeof schema.bots | typeof schema.threads | typeof schema.groups) =>
      new Set((await this.ctx.db.select({ id: table.id }).from(table)).map((r) => r.id));
    const [bots, threads, groups] = await Promise.all([
      ids(schema.bots),
      ids(schema.threads),
      ids(schema.groups),
    ]);
    const found: string[] = [];
    for (const { bot, threads: inBot } of threadDirs) {
      if (!bots.has(bot)) found.push(join(root, 'bots', bot));
      else for (const id of inBot) if (!threads.has(id)) found.push(join(root, 'bots', bot, 'threads', id));
    }
    for (const id of groupDirs) if (!groups.has(id)) found.push(join(root, 'groups', id));
    for (const id of browserDirs) if (!bots.has(id)) found.push(join(this.dataDir, 'browsers', id));
    // A folder changed a moment ago is still in someone's hands (a bot being deleted, say).
    const settled = await Promise.all(
      found.map(async (path) => {
        const at = (await stat(path).catch(() => null))?.mtimeMs ?? 0;
        return Date.now() - at >= GRACE_MS ? path : null;
      }),
    );
    return Promise.all(
      settled.filter((p): p is string => !!p).map(async (path) => ({ path, bytes: await size(path) })),
    );
  }

  async check(): Promise<DoctorReport> {
    const [turns, approvals, stray, seal] = await Promise.all([
      this.stuckTurns(),
      this.staleApprovals(),
      this.strayFolders(),
      this.services.contentSeal.status(),
    ]);
    const checks: DoctorCheck[] = [
      { id: 'stuckTurns', status: turns.length ? 'warn' : 'ok', count: turns.length, repairable: true },
      {
        id: 'staleApprovals',
        status: approvals.length ? 'warn' : 'ok',
        count: approvals.length,
        repairable: true,
      },
      {
        id: 'strayFolders',
        status: stray.length ? 'warn' : 'ok',
        count: stray.length,
        bytes: stray.reduce((a, b) => a + b.bytes, 0),
        repairable: true,
      },
      {
        id: 'unreadable',
        status: seal.unreadable ? 'error' : 'ok',
        count: seal.unreadable,
        repairable: false,
      },
    ];
    try {
      const fs = await statfs(this.dataDir);
      const free = fs.bavail * fs.bsize;
      checks.push({
        id: 'disk',
        status: free < DISK_CRITICAL ? 'error' : free < DISK_LOW ? 'warn' : 'ok',
        count: 0,
        bytes: free,
        repairable: false,
      });
    } catch {
      // A system that cannot say its free space gets no line for it.
    }
    return { checkedAt: new Date().toISOString(), checks };
  }

  /** Mends what the chosen checks find, then checks again. */
  async repair(ids: DoctorCheckId[]): Promise<DoctorReport> {
    let movedTo: string | undefined;
    if (ids.includes('stuckTurns')) await this.services.turns.endStuck(await this.stuckTurns());
    if (ids.includes('staleApprovals')) {
      const stale = await this.staleApprovals();
      if (stale.length) {
        await this.ctx.db
          .update(schema.approvals)
          .set({ status: 'expired', decidedAt: new Date() })
          .where(and(inArray(schema.approvals.id, stale), eq(schema.approvals.status, 'pending')));
        this.ctx.bus.refresh({ scope: 'approvals' });
      }
    }
    if (ids.includes('strayFolders')) {
      const stray = await this.strayFolders();
      if (stray.length) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const trash = join(this.dataDir, 'doctor-trash', stamp);
        for (const s of stray) {
          // Kept at the same place under the trash folder, so it is clear where each came from.
          const to = join(trash, relative(this.dataDir, s.path));
          await mkdir(dirname(to), { recursive: true, mode: 0o700 });
          await rename(s.path, to);
        }
        movedTo = trash;
      }
    }
    return { ...(await this.check()), ...(movedTo && { movedTo }) };
  }
}
