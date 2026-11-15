import { type ClaudeModel, type Effort } from '@yumakbot/shared';
import { Check, Loader2 } from 'lucide-react';
import { useT } from '@/i18n';
import { useClaudeModels } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Chip } from './onboarding/Chip';

/** The CLI's own "default" row stands for "no model named"; it is offered as the empty choice. */
const CLI_DEFAULT = 'default';

export interface ModelChoice {
  model: string;
  effort: Effort | '';
}

/** The model a choice uses, from the list the server sent; undefined for the default. */
function find(models: ClaudeModel[], value: string) {
  return models.find((m) => m.value === (value || CLI_DEFAULT));
}

/** Effort levels the chosen model accepts; the default row's when no model is named. */
export function effortsFor(models: ClaudeModel[], model: string): Effort[] {
  return find(models, model)?.efforts ?? (model ? [] : (models[0]?.efforts ?? []));
}

/** Picks the default model and effort for Claude bots. */
export function ModelDefaults({ value, onChange }: { value: ModelChoice; onChange(v: ModelChoice): void }) {
  const t = useT();
  const { data: models = [], isLoading } = useClaudeModels();
  if (isLoading) return <Loader2 className="size-5 animate-spin text-muted-foreground" />;
  const named = models.filter((m) => m.value !== CLI_DEFAULT);
  const efforts = effortsFor(models, value.model);
  const pick = (model: string) => {
    const allowed = effortsFor(models, model);
    onChange({ model, effort: value.effort && allowed.includes(value.effort) ? value.effort : '' });
  };
  const rows: { value: string; name: string; description: string }[] = [
    { value: '', name: t('model.default'), description: t('model.defaultHint') },
    // Keep a model chosen earlier visible even if this login no longer lists it.
    ...(value.model && !find(models, value.model)
      ? [{ value: value.model, name: value.model, description: '' }]
      : []),
    ...named,
  ];
  return (
    <div className="space-y-6">
      <div className="grid gap-2" role="radiogroup" aria-label={t('model.defaultModel')}>
        {rows.map((m) => {
          const on = m.value === value.model;
          return (
            <button
              key={m.value || CLI_DEFAULT}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => pick(m.value)}
              className={cn(
                'flex items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-colors hover:bg-accent',
                on && 'border-[var(--brand)]/60 bg-[var(--brand)]/10 hover:bg-[var(--brand)]/15',
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{m.name}</span>
                {m.description && (
                  <span className="block text-xs text-muted-foreground">{m.description}</span>
                )}
              </span>
              {on && <Check className="size-4 shrink-0 text-[var(--brand)]" />}
            </button>
          );
        })}
      </div>
      <div className="space-y-3">
        <div>
          <div className="text-sm font-medium">{t('model.effort')}</div>
          <div className="text-xs text-muted-foreground">
            {efforts.length ? t('model.effortHint') : t('model.noEffort')}
          </div>
        </div>
        {efforts.length > 0 && (
          <div className="flex flex-wrap gap-2">
            <Chip on={!value.effort} onClick={() => onChange({ ...value, effort: '' })}>
              {t('model.effortDefault')}
            </Chip>
            {efforts.map((e) => (
              <Chip key={e} on={value.effort === e} onClick={() => onChange({ ...value, effort: e })}>
                {t(`effort.${e}`)}
              </Chip>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
