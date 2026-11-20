import type { RoutineStep, RoutineStepRun } from '@yumakbot/shared';
import { RoutineStep as StepSchema } from '@yumakbot/shared';
import type { schema } from '../db';
import { iso } from '../util';

type StepRow = typeof schema.routineStepRuns.$inferSelect;

/** How much of a step's output a run's list shows; the conversation has all of it. */
const SHOWN_OUTPUT = 400;

/**
 * The steps a run was started with. Read leniently: a step this server no longer knows (written by a
 * newer one, then the server went back) is dropped rather than failing the whole run's view.
 */
export function snapshotSteps(raw: unknown): RoutineStep[] | null {
  if (!Array.isArray(raw)) return null;
  const steps: RoutineStep[] = [];
  for (const item of raw) {
    const parsed = StepSchema.safeParse(item);
    if (parsed.success) steps.push(parsed.data);
  }
  return steps;
}

/** The kind a run's step at `position` has: its own instruction first, then the steps after it. */
export function kindAt(steps: readonly RoutineStep[], position: number): string {
  return position === 0 ? 'prompt' : (steps[position - 1]?.kind ?? 'agent');
}

/** Every step of a run, with the ones that have not started as `pending`. */
export function stepList(steps: readonly RoutineStep[], rows: readonly StepRow[]): RoutineStepRun[] {
  const at = new Map(rows.map((r) => [r.position, r]));
  return Array.from({ length: steps.length + 1 }, (_, position) => {
    const row = at.get(position);
    if (!row) {
      return {
        position,
        kind: kindAt(steps, position),
        status: 'pending' as const,
        output: null,
        reason: null,
        startedAt: null,
        finishedAt: null,
      };
    }
    const output = row.output?.trim() ? row.output.trim() : null;
    return {
      position,
      kind: row.kind,
      status: row.status,
      output: output && output.length > SHOWN_OUTPUT ? `${output.slice(0, SHOWN_OUTPUT)}…` : output,
      reason: row.reason,
      startedAt: row.startedAt.toISOString(),
      finishedAt: iso(row.finishedAt),
    };
  });
}
