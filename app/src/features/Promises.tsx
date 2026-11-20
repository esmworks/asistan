import type { Pledge } from '@yumakbot/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Check, X } from 'lucide-react';
import { toast } from 'sonner';
import { BotAvatar } from '@/components/BotAvatar';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useBots, usePromises, useSettings } from '@/lib/queries';
import { cn } from '@/lib/utils';

/** Closes or drops a promise, and brings every list that shows it up to date. */
function useClosePromise() {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['promises'] });
  const done = useMutation({ mutationFn: api.promiseDone, onSuccess: refresh, onError: onFail(refresh) });
  const drop = useMutation({ mutationFn: api.promiseDrop, onSuccess: refresh, onError: onFail(refresh) });
  return { done, drop };
}

const onFail = (refresh: () => unknown) => (e: unknown) => {
  toast.error((e as Error).message);
  void refresh();
};

/**
 * The small line under a bot's reply that made a promise: where it stands on the calendar, and a
 * way to take it back. Nothing is shown once the promise is closed.
 */
export function PromiseLine({ id }: { id: string }) {
  const t = useT();
  const f = useFormat();
  const { data: promises = [] } = usePromises();
  const { drop } = useClosePromise();
  const p = promises.find((x) => x.id === id);
  if (!p) return null;
  return (
    <div className="mb-1 mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
      <CalendarClock className="size-3.5 shrink-0" />
      <span>
        {p.scheduled && p.dueAt
          ? t('promise.lineKept', { when: f.dayLabel(p.dueAt) })
          : t('promise.lineNoted', { what: p.text })}
      </span>
      <button
        type="button"
        disabled={drop.isPending}
        onClick={() => drop.mutate(p.id)}
        className="font-medium text-foreground hover:underline"
      >
        {p.scheduled && p.dueAt ? t('promise.cancel') : t('promise.drop')}
      </button>
    </div>
  );
}

/**
 * The person's open promises, the overdue ones first: what a bot said it would do for them and what
 * they promised others. Each can be marked done or dropped, which also removes a routine still
 * waiting for it. Nothing is shown when there are none.
 */
export function PromisesSection({ enabled, onOpen }: { enabled: boolean; onOpen(p: Pledge): void }) {
  const t = useT();
  const f = useFormat();
  const { data: promises = [] } = usePromises(enabled);
  const { data: bots = [] } = useBots();
  const { data: settings } = useSettings();
  const qc = useQueryClient();
  // Not the settings dialog's own hook: this file is imported by the message list, which that dialog imports too.
  const save = useMutation({
    mutationFn: api.updateSettings,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
    onError: (e) => toast.error((e as Error).message),
  });
  const { done, drop } = useClosePromise();
  if (!promises.length) return null;
  const busy = done.isPending || drop.isPending;
  return (
    <section>
      <h3 className="mb-1.5 px-1 text-xs font-medium text-muted-foreground">{t('promise.title')}</h3>
      <div className="divide-y rounded-2xl border bg-card/50">
        {promises.map((p) => {
          const bot = bots.find((b) => b.id === p.botId);
          return (
            <div key={p.id} className="space-y-1 px-3 py-2.5">
              <div className="flex items-start gap-2">
                {bot && <BotAvatar avatar={bot.avatar} color={bot.color} seed={bot.id} size={24} />}
                <button
                  type="button"
                  onClick={() => onOpen(p)}
                  className="min-w-0 flex-1 text-left font-medium hover:underline"
                >
                  {p.text}
                </button>
              </div>
              <div className="text-xs text-muted-foreground">
                {p.madeBy === 'bot'
                  ? t('promise.byBot', { bot: bot?.name ?? t('common.bot') })
                  : p.toWhom
                    ? t('promise.byYouTo', { name: p.toWhom })
                    : t('promise.byYou')}
                {p.dueAt && (
                  <span className={cn(p.overdue && 'font-medium text-destructive')}>
                    {' · '}
                    {p.overdue ? t('promise.overdue') : t('promise.due')}{' '}
                    {p.dueHasTime ? f.dayLabel(p.dueAt) : f.calendarDay(p.dueAt.slice(0, 10))}
                  </span>
                )}
                {p.condition && ` · ${t('promise.waitingFor', { condition: p.condition })}`}
                {p.scheduled && ` · ${t('promise.scheduled')}`}
              </div>
              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => done.mutate(p.id)}
                  className="flex items-center gap-1 text-xs font-medium hover:underline"
                >
                  <Check className="size-3.5" />
                  {t('promise.done')}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => drop.mutate(p.id)}
                  className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:underline"
                >
                  <X className="size-3.5" />
                  {t('promise.drop')}
                </button>
              </div>
            </div>
          );
        })}
        {settings?.promiseRemindAt && (
          <label className="flex items-center justify-between gap-3 px-3 py-2 text-xs text-muted-foreground">
            {t('promise.remindAt')}
            <Input
              type="time"
              className="h-8 w-28 rounded-full"
              defaultValue={settings.promiseRemindAt}
              key={settings.promiseRemindAt}
              onBlur={(e) => {
                const v = e.target.value;
                if (/^\d{2}:\d{2}$/.test(v) && v !== settings.promiseRemindAt)
                  save.mutate({ promiseRemindAt: v });
              }}
            />
          </label>
        )}
      </div>
    </section>
  );
}
