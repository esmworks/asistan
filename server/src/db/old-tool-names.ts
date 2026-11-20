import { sql } from 'drizzle-orm';
import type { Db } from './index';

/**
 * Where a tool's name is kept, as [table, column, whether the column is jsonb]. The app's own tools
 * were `mcp__yumakbot__*` before the rename and are `mcp__leafbot__*` now; migration 0084 rewrote
 * the rows it found, and this rewrites rows that come back later from a backup made before it.
 */
const KEPT: readonly [string, string, boolean][] = [
  ['permission_rules', 'pattern', false],
  ['approvals', 'tool_name', false],
  ['bot_actions', 'tool_name', false],
  ['canary_alarms', 'tool', false],
  ['bots', 'tool_selection', true],
  ['routines', 'steps', true],
  ['routine_runs', 'steps_snapshot', true],
  ['skills', 'steps', true],
  ['messages', 'props', true],
];

export async function renameOldToolNames(db: Pick<Db, 'execute'>): Promise<void> {
  for (const [table, column, json] of KEPT) {
    const t = sql.identifier(table);
    const c = sql.identifier(column);
    await db.execute(
      json
        ? sql`update ${t} set ${c} = replace(${c}::text, 'mcp__yumakbot__', 'mcp__leafbot__')::jsonb
              where ${c}::text like '%mcp\\_\\_yumakbot\\_\\_%'`
        : sql`update ${t} set ${c} = replace(${c}, 'mcp__yumakbot__', 'mcp__leafbot__')
              where ${c} like '%mcp\\_\\_yumakbot\\_\\_%'`,
    );
  }
}
