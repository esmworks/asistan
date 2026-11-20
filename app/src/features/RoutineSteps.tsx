import type { RoutineRun, RoutineStepRun } from '@yumakbot/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowUp,
  Bot as BotIcon,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  CircleX,
  LoaderCircle,
  Plus,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useT, type MessageKey } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

/** A step as the routine's window edits it; text fields stay strings while typed. */
export interface StepForm {
  id: string;
  kind: 'agent';
  prompt: string;
  model: string;
}

/** A new step's id: short, unique within the routine, and of the letters the server takes. */
function newStepId(): string {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function newAgentStep(): StepForm {
  return { id: newStepId(), kind: 'agent', prompt: '', model: '' };
}

/**
 * The steps after the routine's own instruction, each a card in the order they run: what it does,
 * the model it runs on, and buttons to move or remove it.
 */
export function StepsEditor({
  steps,
  onChange,
  errors,
  modelListId,
  modelPlaceholder,
}: {
  steps: StepForm[];
  onChange(next: StepForm[]): void;
  /** Message keys of the steps' prompts that did not pass, by position. */
  errors?: (string | undefined)[];
  /** The datalist of models the model fields offer. */
  modelListId: string;
  modelPlaceholder: string;
}) {
  const t = useT();
  const set = (i: number, patch: Partial<StepForm>) =>
    onChange(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number, by: -1 | 1) => {
    const next = [...steps];
    const [s] = next.splice(i, 1);
    next.splice(i + by, 0, s!);
    onChange(next);
  };
  return (
    <div className="space-y-2">
      <div className="space-y-0.5">
        <div className="text-sm text-muted-foreground">{t('routine.steps')}</div>
        <p className="text-xs text-muted-foreground">{t('routine.stepsHint')}</p>
      </div>
      {steps.map((s, i) => (
        <div key={s.id} className="space-y-2 rounded-2xl border px-3 py-2.5">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <BotIcon className="size-3.5" aria-hidden />
            <span className="min-w-0 flex-1">{t('routine.step.agent')}</span>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7 rounded-full"
              disabled={i === 0}
              onClick={() => move(i, -1)}
              aria-label={t('routine.stepUp')}
            >
              <ArrowUp className="size-3.5" />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7 rounded-full"
              disabled={i === steps.length - 1}
              onClick={() => move(i, 1)}
              aria-label={t('routine.stepDown')}
            >
              <ArrowDown className="size-3.5" />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7 rounded-full"
              onClick={() => onChange(steps.filter((_, j) => j !== i))}
              aria-label={t('routine.stepRemove')}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
          <Textarea
            value={s.prompt}
            onChange={(e) => set(i, { prompt: e.target.value })}
            rows={3}
            placeholder={t('routine.stepPromptPlaceholder')}
            className="scroll-thin max-h-60 overflow-y-auto rounded-xl"
            aria-label={t('routine.step.agent')}
          />
          {errors?.[i] && <p className="text-sm text-destructive">{t(errors[i] as MessageKey)}</p>}
          <Input
            value={s.model}
            onChange={(e) => set(i, { model: e.target.value })}
            list={modelListId}
            placeholder={modelPlaceholder}
            className="h-8 rounded-xl text-sm"
            aria-label={t('routine.stepModel')}
          />
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="rounded-full"
        onClick={() => onChange([...steps, newAgentStep()])}
      >
        <Plus /> {t('routine.addAgentStep')}
      </Button>
    </div>
  );
}

const STEP_ICON: Record<RoutineStepRun['status'], typeof CircleCheck> = {
  pending: CircleDashed,
  running: LoaderCircle,
  waiting: LoaderCircle,
  done: CircleCheck,
  error: CircleX,
  stopped: CircleSlash,
  skipped: CircleDashed,
};

/** The name a step of a run goes by in its list. */
function stepLabel(s: RoutineStepRun, t: ReturnType<typeof useT>): string {
  if (s.kind === 'prompt') return t('routine.step.prompt');
  return t(`routine.step.${s.kind}` as MessageKey);
}

/**
 * How each step of a run went, under the run in the routine's list. A run that failed or was
 * stopped part way can go on from that step.
 */
export function RunSteps({ run }: { run: RoutineRun }) {
  const t = useT();
  const qc = useQueryClient();
  const retry = useMutation({
    mutationFn: () => api.retryRoutineRun(run.routineId, run.id),
    onSuccess: () => {
      toast.success(t('routine.retried'));
      void qc.invalidateQueries({ queryKey: ['routine-runs', run.routineId] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  if (!run.steps?.length) return null;
  const halted = run.status === 'error' || run.status === 'stopped';
  return (
    <div className="mt-1 ml-4 space-y-1 border-l pl-3">
      {run.steps.map((s) => {
        const Icon = STEP_ICON[s.status] ?? CircleDashed;
        return (
          <div key={s.position} className="flex items-start gap-2 text-xs">
            <Icon
              className={cn(
                'mt-0.5 size-3.5 shrink-0',
                s.status === 'done' && 'text-emerald-500',
                (s.status === 'error' || s.status === 'stopped') && 'text-destructive',
                (s.status === 'running' || s.status === 'waiting') && 'animate-spin text-amber-500',
                (s.status === 'pending' || s.status === 'skipped') && 'text-muted-foreground/60',
              )}
              aria-hidden
            />
            <span className="min-w-0 flex-1">
              <span
                className={cn(
                  'block',
                  (s.status === 'pending' || s.status === 'skipped') && 'text-muted-foreground',
                )}
              >
                {stepLabel(s, t)} · {t(`routine.stepStatus.${s.status}`)}
              </span>
              {(s.reason || s.output) && (
                <span className="block truncate text-muted-foreground">{s.reason ?? s.output}</span>
              )}
            </span>
          </div>
        );
      })}
      {halted && (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="h-7 rounded-full px-3 text-xs"
          disabled={retry.isPending}
          onClick={() => retry.mutate()}
        >
          <RotateCcw className="size-3.5" /> {t('routine.retryRun')}
        </Button>
      )}
    </div>
  );
}
