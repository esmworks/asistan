import { asc, eq, gt, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { Ctx } from '../context';
import { schema } from '../db';
import { contentSealed, isSealed, setSealing } from '../db/sealed';

const SETTING = 'setting.contentEncryption';
/** Rows converted per query, so a large history does not hold the database for long. */
const BATCH = 200;

interface Sealed {
  table: PgTable;
  id: PgColumn;
  /** Each sealed column with its property name in the table's definition. */
  columns: [string, PgColumn][];
}

const SEALED: Sealed[] = [
  { table: schema.messages, id: schema.messages.id, columns: [['text', schema.messages.text]] },
  { table: schema.turns, id: schema.turns.id, columns: [['prompt', schema.turns.prompt]] },
  { table: schema.memories, id: schema.memories.id, columns: [['content', schema.memories.content]] },
  {
    table: schema.memoryChanges,
    id: schema.memoryChanges.id,
    columns: [
      ['content', schema.memoryChanges.content],
      ['before', schema.memoryChanges.before],
    ],
  },
  {
    table: schema.jobs,
    id: schema.jobs.id,
    columns: [
      ['request', schema.jobs.request],
      ['reply', schema.jobs.reply],
    ],
  },
  {
    table: schema.emails,
    id: schema.emails.id,
    columns: [
      ['subject', schema.emails.subject],
      ['text', schema.emails.text],
    ],
  },
  { table: schema.tickets, id: schema.tickets.id, columns: [['description', schema.tickets.description]] },
  {
    table: schema.ticketComments,
    id: schema.ticketComments.id,
    columns: [['text', schema.ticketComments.text]],
  },
];

/** Whether a value as stored is not yet as the switch says. */
const stale = (raw: unknown, on: boolean) =>
  typeof raw === 'string' && raw !== '' && (on ? !isSealed(raw) : isSealed(raw));

/**
 * Turns sealing of content at rest on or off, and converts what is already stored to match: each
 * row is read (opened if sealed) and written back (sealed or not by the new switch). Reads open
 * sealed values whatever the switch says, so the app keeps working while rows are converted.
 */
export class ContentSealService {
  private converting: Promise<void> | null = null;

  constructor(private ctx: Ctx) {}

  async enabled(): Promise<boolean> {
    const [row] = await this.ctx.db.select().from(schema.kv).where(eq(schema.kv.key, SETTING)).limit(1);
    return row?.value === true;
  }

  /** Applies the saved switch at start, and finishes a conversion a restart cut off. */
  async start() {
    setSealing(await this.enabled());
    if ((await this.status()).pending) this.convert();
  }

  /** The switch, and how many stored values are not yet as it says. */
  async status(): Promise<{ on: boolean; pending: number; converting: boolean }> {
    const on = contentSealed();
    let pending = 0;
    for (const { table, columns } of SEALED) {
      for (const [, c] of columns) {
        // Counted as stored: a literal pattern, so the column type does not seal it on the way in.
        const where = on
          ? sql`${c} is not null and ${c} <> '' and ${c} not like 'yb1:%'`
          : sql`${c} like 'yb1:%'`;
        const [row] = await this.ctx.db
          .select({ n: sql<number>`count(*)`.mapWith(Number) })
          .from(table)
          .where(where);
        pending += row?.n ?? 0;
      }
    }
    return { on, pending, converting: !!this.converting };
  }

  async set(on: boolean) {
    await this.ctx.db
      .insert(schema.kv)
      .values({ key: SETTING, value: on })
      .onConflictDoUpdate({ target: schema.kv.key, set: { value: on } });
    setSealing(on);
    this.convert();
    this.ctx.bus.refresh({ scope: 'info' });
  }

  private convert() {
    this.converting ??= this.run()
      .catch((err) => console.error('Converting content at rest failed', err))
      .finally(() => {
        this.converting = null;
        this.ctx.bus.refresh({ scope: 'info' });
      });
  }

  /** Waits for a conversion under way. */
  async settled() {
    await this.converting;
  }

  private async run() {
    for (const { table, id, columns } of SEALED) {
      let after = '';
      for (;;) {
        const on = contentSealed();
        const fields: Record<string, PgColumn | ReturnType<typeof sql>> = { id };
        // Each column twice: as stored, to see whether it needs converting, and opened, to write back.
        for (const [name, c] of columns) {
          fields[`raw_${name}`] = sql`${c}`;
          fields[name] = c;
        }
        const rows = (await this.ctx.db
          .select(fields as never)
          .from(table)
          .where(gt(id, after))
          .orderBy(asc(id))
          .limit(BATCH)) as Record<string, string | null>[];
        if (!rows.length) break;
        for (const r of rows) {
          const set: Record<string, string> = {};
          for (const [name] of columns) if (stale(r[`raw_${name}`], on)) set[name] = r[name]!;
          if (Object.keys(set).length) await this.ctx.db.update(table).set(set).where(eq(id, r.id!));
        }
        after = rows.at(-1)!.id!;
      }
    }
  }
}
