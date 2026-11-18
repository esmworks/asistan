import {
  planPace,
  ROUTINE_GATE_MODES,
  USAGE_RANGES,
  type PlanWindow,
  type UsageRange,
  type UsageReport,
} from '@yumakbot/shared';
import { Download, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { BotAvatar } from '@/components/BotAvatar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useT } from '@/i18n';
import { useFormat } from '@/lib/format';
import { useBots, useSettings, useUsage } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Chip } from './onboarding/Chip';
import { Card, Row, useSaveSettings } from './SettingsDialog';

/** What the bots cost over a period: a total, the cost per day and the cost per bot. */
export function UsageTab() {
  const t = useT();
  const f = useFormat();
  const [days, setDays] = useState<UsageRange>(30);
  const [botId, setBotId] = useState<string | null>(null);
  const { data, isPending, isError } = useUsage(days, botId ?? undefined);
  const { data: bots } = useBots();

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-sm text-muted-foreground">{t('usage.total')}</div>
          <div className="text-3xl font-semibold tabular-nums">{data ? f.usd(data.total.costUsd) : '–'}</div>
          <div className="text-sm text-muted-foreground tabular-nums">
            {data ? t('usage.turnCount', { count: data.total.turns }) : ' '}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Select value={botId ?? ALL} onValueChange={(v) => setBotId(v === ALL ? null : v)}>
            <SelectTrigger className="w-44 rounded-full" aria-label={t('usage.botFilter')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t('usage.allBots')}</SelectItem>
              {(bots ?? []).map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={String(days)} onValueChange={(v) => setDays(Number(v) as UsageRange)}>
            <SelectTrigger className="w-44 rounded-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {USAGE_RANGES.map((d) => (
                <SelectItem key={d} value={String(d)}>
                  {t(`usage.range.${d}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {isPending ? (
        <div className="flex justify-center py-16 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : isError || !data ? (
        <p className="py-16 text-center text-sm text-muted-foreground">{t('usage.failed')}</p>
      ) : (
        <Report data={data} filtered={botId !== null} onPickBot={setBotId} />
      )}
      <PlanUsage plan={data?.plan} />
      <MonthLimit month={data?.month} />
      <RoutineGate gate={data?.gate} />
      <Parallel parallel={data?.parallel} />
      <Button variant="secondary" size="sm" className="rounded-full" asChild>
        <a href={`/api/usage/turns.csv?days=${days}`} download>
          <Download /> {t('usage.downloadCsv')}
        </a>
      </Button>
    </>
  );
}

/** This month's spending against the limit, and the limit itself (empty or 0 for none). */
function MonthLimit({ month }: { month?: UsageReport['month'] }) {
  const t = useT();
  const f = useFormat();
  const { data: settings } = useSettings();
  const save = useSaveSettings();
  const [draft, setDraft] = useState<string | null>(null);
  const limit = settings?.monthlyLimitUsd ?? 0;
  const value = draft ?? (limit ? String(limit) : '');
  const commit = () => {
    if (draft === null) return;
    const n = Number(draft.replace(',', '.'));
    setDraft(null);
    if (!Number.isFinite(n) || n < 0 || n === limit) return;
    save.mutate({ monthlyLimitUsd: Math.round(n * 100) / 100 });
  };
  const share = month && month.limitUsd > 0 ? Math.min(1, month.costUsd / month.limitUsd) : 0;
  return (
    <Card title={t('usage.month')}>
      <Row
        label={month ? f.usd(month.costUsd) : '–'}
        hint={
          month && month.limitUsd > 0
            ? t('usage.monthOf', { limit: f.usd(month.limitUsd) })
            : t('usage.noLimit')
        }
      >
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          {t('usage.limit')}
          <Input
            inputMode="decimal"
            value={value}
            placeholder="0"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && commit()}
            className="h-8 w-24 rounded-full text-right tabular-nums"
            aria-label={t('usage.limit')}
          />
        </label>
      </Row>
      {month && month.limitUsd > 0 && (
        <div className="px-4 pb-4">
          <div className="h-2 overflow-hidden rounded-full bg-secondary">
            <div
              className={cn(
                'h-full rounded-full',
                share >= 1 ? 'bg-red-500' : share >= 0.8 ? 'bg-amber-500' : 'bg-emerald-500',
              )}
              style={{ width: `${share * 100}%` }}
            />
          </div>
        </div>
      )}
    </Card>
  );
}

/**
 * The small-model check before routine runs that a watched page or a webhook started: off,
 * watching only, or on; and over the period, what it cost and what it would have saved.
 */
function RoutineGate({ gate }: { gate?: UsageReport['gate'] }) {
  const t = useT();
  const f = useFormat();
  const { data: settings } = useSettings();
  const save = useSaveSettings();
  const mode = settings?.routineGate;
  // A server older than the check does not offer it.
  if (!mode) return null;
  return (
    <Card title={t('usage.gate')}>
      <Row label={t(`usage.gate.${mode}`)} hint={t(`usage.gate.${mode}Hint`)}>
        <div className="flex flex-wrap gap-2">
          {ROUTINE_GATE_MODES.map((m) => (
            <Chip key={m} on={mode === m} onClick={() => m !== mode && save.mutate({ routineGate: m })}>
              {t(`usage.gate.choice.${m}`)}
            </Chip>
          ))}
        </div>
      </Row>
      {gate && (
        <div className="space-y-1 px-4 pb-4 text-sm text-muted-foreground tabular-nums">
          <div>{t('usage.gate.checks', { count: gate.checks, cost: f.usd(gate.costUsd) })}</div>
          {gate.skippable > 0 && (
            <div>
              {t('usage.gate.skippable', { count: gate.skippable, cost: f.usd(gate.skippableCostUsd) })}
            </div>
          )}
          {gate.skipped > 0 && <div>{t('usage.gate.skipped', { count: gate.skipped })}</div>}
        </div>
      )}
    </Card>
  );
}

const PLAN_LABELS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'] as const;

/** A plan window's name: the account's own, a known one translated, else its kind as given. */
export function planLabel(w: PlanWindow, t: ReturnType<typeof useT>): string {
  if (w.label) return w.label;
  const known = PLAN_LABELS.find((k) => k === w.kind);
  return known ? t(`usage.plan.${known}`) : w.kind;
}

/**
 * The Claude plan's usage windows, each a bar with a line where the window's time stands: a bar
 * past its line spends the plan faster than the window lasts.
 */
function PlanUsage({ plan }: { plan?: UsageReport['plan'] }) {
  const t = useT();
  const f = useFormat();
  // The time the page opened: the marks stay put while it is read.
  const [now] = useState(() => Date.now());
  if (!plan?.windows.length) return null;
  return (
    <Card title={t('usage.plan')}>
      <div className="space-y-4 px-4 py-4">
        {plan.windows.map((w) => {
          const pace = planPace(w, now);
          const used = w.used ?? 0;
          return (
            <div key={w.kind} className="space-y-1.5">
              <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className="font-medium">{planLabel(w, t)}</span>
                <span className="text-muted-foreground tabular-nums">
                  {w.used === null ? '–' : t('usage.plan.used', { percent: Math.round(used * 100) })}
                  {w.resetsAt && ` · ${t('usage.plan.resets', { time: f.dayLabel(w.resetsAt) })}`}
                </span>
              </div>
              <div className="relative h-2 rounded-full bg-secondary">
                <div
                  className={cn(
                    'h-full rounded-full',
                    used >= 0.9
                      ? 'bg-red-500'
                      : pace !== null && used > pace
                        ? 'bg-amber-500'
                        : 'bg-emerald-500',
                  )}
                  style={{ width: `${used * 100}%` }}
                />
                {pace !== null && (
                  <div
                    className="absolute -top-1 -bottom-1 w-0.5 rounded-full bg-foreground/60"
                    style={{ left: `calc(${pace * 100}% - 1px)` }}
                    aria-hidden
                  />
                )}
              </div>
            </div>
          );
        })}
        <p className="text-xs text-muted-foreground">{t('usage.plan.hint')}</p>
        <p className="text-xs text-muted-foreground">{t('usage.plan.seen', { time: f.dayLabel(plan.at) })}</p>
      </div>
    </Card>
  );
}

/** How many turns may run at once; 0 leaves it to the server. */
function Parallel({ parallel }: { parallel?: UsageReport['parallel'] }) {
  const t = useT();
  const { data: settings } = useSettings();
  const save = useSaveSettings();
  // A server older than the setting does not offer it.
  if (!parallel || settings?.maxTurns === undefined) return null;
  const value = settings.maxTurns;
  return (
    <Card title={t('usage.parallel')}>
      <Row label={t('usage.parallel')} hint={t('usage.parallel.hint')}>
        <Select value={String(value)} onValueChange={(v) => save.mutate({ maxTurns: Number(v) })}>
          <SelectTrigger className="w-40 rounded-full" aria-label={t('usage.parallel')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PARALLEL_CHOICES.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n === 0 ? t('usage.parallel.default', { count: parallel.serverDefault }) : String(n)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
    </Card>
  );
}

/** 0 is the server's own number. */
const PARALLEL_CHOICES = [0, 1, 2, 3, 4, 5, 6, 8, 10];

/** The bot filter's value for every bot; bot ids never take this form. */
const ALL = '*';

function Report({
  data,
  filtered,
  onPickBot,
}: {
  data: UsageReport;
  filtered: boolean;
  onPickBot: (botId: string) => void;
}) {
  const t = useT();
  const f = useFormat();
  const { data: bots } = useBots();
  const byId = new Map((bots ?? []).map((b) => [b.id, b]));
  return (
    <>
      <Card title={t('usage.daily')}>
        <div className="p-4">
          <DailyChart daily={data.daily} />
        </div>
      </Card>
      {!filtered && (
        <Card title={t('usage.bots')}>
          {data.bots.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">{t('usage.empty')}</p>
          ) : (
            data.bots.map((b) => {
              const bot = byId.get(b.botId);
              const share = data.total.costUsd > 0 ? b.costUsd / data.total.costUsd : 0;
              return (
                <button
                  type="button"
                  key={b.botId}
                  title={t('usage.showBot')}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-accent/50"
                  onClick={() => onPickBot(b.botId)}
                >
                  {bot ? (
                    <BotAvatar avatar={bot.avatar} color={bot.color} seed={bot.id} size={28} />
                  ) : (
                    <span className="size-7 shrink-0 rounded-full bg-secondary" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2 text-sm">
                      <span className="truncate">{b.name || '–'}</span>
                      {b.archived && (
                        <span className="shrink-0 text-xs text-muted-foreground">{t('usage.archived')}</span>
                      )}
                    </div>
                    {/* Its part of the total, on one scale for every bot. */}
                    <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-secondary">
                      <div className="h-full rounded-full bg-primary" style={{ width: `${share * 100}%` }} />
                    </div>
                  </div>
                  <div className="w-20 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                    {t('usage.turnCount', { count: b.turns })}
                  </div>
                  <div className="w-20 shrink-0 text-right text-sm font-medium tabular-nums">
                    {f.usd(b.costUsd)}
                  </div>
                </button>
              );
            })
          )}
        </Card>
      )}
      <Card title={t('usage.models')}>
        {data.models.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">{t('usage.empty')}</p>
        ) : (
          data.models.map((m) => {
            const share = data.total.costUsd > 0 ? m.costUsd / data.total.costUsd : 0;
            return (
              <div key={`${m.engine}:${m.model}`} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 text-sm">
                    <span className="truncate">
                      {m.model || (m.engine ? t('usage.defaultModel') : t('usage.unknownModel'))}
                    </span>
                    {m.engine && (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {t(`bot.engine.${m.engine}`)}
                      </span>
                    )}
                  </div>
                  <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-secondary">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${share * 100}%` }} />
                  </div>
                </div>
                <div className="w-20 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                  {t('usage.turnCount', { count: m.turns })}
                </div>
                <div className="w-20 shrink-0 text-right text-sm font-medium tabular-nums">
                  {f.usd(m.costUsd)}
                </div>
              </div>
            );
          })
        )}
      </Card>
      {!!data.routines?.length && (
        <Card title={t('usage.routines')}>
          {data.routines.map((r) => {
            const share = data.total.costUsd > 0 ? r.costUsd / data.total.costUsd : 0;
            const bot = r.botId ? byId.get(r.botId) : undefined;
            return (
              <div key={r.routineId} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 text-sm">
                    <span className="truncate">{r.name}</span>
                    {bot && !filtered && (
                      <span className="shrink-0 text-xs text-muted-foreground">{bot.name}</span>
                    )}
                  </div>
                  <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-secondary">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${share * 100}%` }} />
                  </div>
                </div>
                <div className="w-20 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                  {t('usage.turnCount', { count: r.turns })}
                </div>
                <div className="w-20 shrink-0 text-right text-sm font-medium tabular-nums">
                  {f.usd(r.costUsd)}
                </div>
              </div>
            );
          })}
        </Card>
      )}
      <div className="space-y-1 px-1 text-xs text-muted-foreground">
        <p>{t('usage.estimate')}</p>
        {data.total.unpriced > 0 && <p>{t('usage.unpriced', { count: data.total.unpriced })}</p>}
      </div>
    </>
  );
}

/** One bar per day, the highest at the top of the plot; hovering a day shows its numbers. */
function DailyChart({ daily }: { daily: UsageReport['daily'] }) {
  const t = useT();
  const f = useFormat();
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...daily.map((d) => d.costUsd));
  const first = daily[0]!;
  const last = daily.at(-1)!;
  const tip = hover === null ? null : daily[hover]!;
  return (
    <figure className="m-0">
      <div className="relative">
        <div className="mb-1 text-xs text-muted-foreground tabular-nums">
          {max > 0 ? f.usd(max) : f.usd(0)}
        </div>
        <div
          role="img"
          aria-label={t('usage.chart', { from: f.calendarDay(first.date), to: f.calendarDay(last.date) })}
          className="relative flex h-36 items-end gap-0.5 border-t border-b border-t-border/40 border-b-border"
          onMouseLeave={() => setHover(null)}
        >
          {daily.map((d, i) => (
            // The whole column is the hover target, not only the bar.
            <div
              key={d.date}
              className={cn(
                'flex h-full min-w-0 flex-1 items-end rounded-t-[4px]',
                hover === i && 'bg-accent',
              )}
              onMouseEnter={() => setHover(i)}
            >
              {d.costUsd > 0 && (
                <div
                  className="w-full rounded-t-[4px] bg-primary"
                  style={{ height: `max(2px, ${(d.costUsd / max) * 100}%)` }}
                />
              )}
            </div>
          ))}
        </div>
        {tip && (
          <div
            className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-lg border bg-popover px-2.5 py-1.5 text-xs whitespace-nowrap text-popover-foreground shadow-md"
            style={{ left: `clamp(70px, ${((hover! + 0.5) / daily.length) * 100}%, calc(100% - 70px))` }}
          >
            <div className="font-medium">{f.calendarDay(tip.date)}</div>
            <div className="text-muted-foreground tabular-nums">
              {f.usd(tip.costUsd)} · {t('usage.turnCount', { count: tip.turns })}
            </div>
          </div>
        )}
      </div>
      <div className="mt-1.5 flex justify-between text-xs text-muted-foreground">
        <span>{f.calendarDay(first.date, true)}</span>
        <span>{f.calendarDay(last.date, true)}</span>
      </div>
      {/* The same numbers for a screen reader. */}
      <table className="sr-only">
        <tbody>
          {daily.map((d) => (
            <tr key={d.date}>
              <td>{f.calendarDay(d.date)}</td>
              <td>{f.usd(d.costUsd)}</td>
              <td>{t('usage.turnCount', { count: d.turns })}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
