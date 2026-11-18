import { type ClaudeModel, type Effort } from '@yumakbot/shared';
import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useT } from '@/i18n';
import { useClaudeModels } from '@/lib/queries';

/** The CLI's own "default" row stands for "no model named"; it is offered as the empty choice. */
const CLI_DEFAULT = 'default';
/** Select items cannot carry an empty value, so "no effort named" travels under this one. */
const NO_EFFORT = 'model';

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

/** A setting on one line: what it is on the left, its box on the right. */
function Line({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="min-w-40 flex-1">
        <div className="text-sm">{label}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

/** Picks the default model and effort for Claude bots, each from a drop-down. */
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
  const chosen = rows.find((m) => m.value === value.model);
  return (
    <div className="space-y-4">
      <Line label={t('model.defaultModel')} hint={chosen?.description || undefined}>
        <Select value={value.model || CLI_DEFAULT} onValueChange={(v) => pick(v === CLI_DEFAULT ? '' : v)}>
          <SelectTrigger className="w-56 rounded-full" aria-label={t('model.defaultModel')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {rows.map((m) => (
              <SelectItem key={m.value || CLI_DEFAULT} value={m.value || CLI_DEFAULT}>
                {m.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Line>
      <Line label={t('model.effort')} hint={efforts.length ? t('model.effortHint') : t('model.noEffort')}>
        {efforts.length > 0 && (
          <Select
            value={value.effort || NO_EFFORT}
            onValueChange={(v) => onChange({ ...value, effort: v === NO_EFFORT ? '' : (v as Effort) })}
          >
            <SelectTrigger className="w-56 rounded-full" aria-label={t('model.effort')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_EFFORT}>{t('model.effortDefault')}</SelectItem>
              {efforts.map((e) => (
                <SelectItem key={e} value={e}>
                  {t(`effort.${e}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Line>
    </div>
  );
}
