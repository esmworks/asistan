import type { TodayReport } from '@yumakbot/shared';
import { useQuery } from '@tanstack/react-query';
import { Brain, CircleAlert, CircleCheck, Clock, Loader2 } from 'lucide-react';
import { BotAvatar } from '@/components/BotAvatar';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useBots, useSummaries } from '@/lib/queries';
import { useUi } from '@/lib/store';
import { cn } from '@/lib/utils';

/**
 * Today at a glance: what waits for the person, what each bot did and what the routines ran,
 * each a click away from its conversation.
 */
export function TodayDialog() {
  const t = useT();
  const f = useFormat();
  const open = useUi((s) => s.todayOpen);
  const setOpen = useUi((s) => s.setTodayOpen);
  const { data } = useQuery({
    queryKey: ['today'],
    queryFn: api.today,
    enabled: open,
    refetchOnMount: 'always',
  });
  const { data: summaries = [] } = useSummaries();
  const { data: bots = [] } = useBots();
  const byId = new Map(bots.map((b) => [b.id, b]));
  const waiting = summaries.filter((s) => s.waiting);
  const go = (botId: string, threadId?: string | null) => {
    const ui = useUi.getState();
    ui.openChat(botId);
    if (threadId) ui.selectThread(threadId);
    setOpen(false);
  };
  const avatar = (botId: string) => {
    const b = byId.get(botId);
    return b ? <BotAvatar avatar={b.avatar} color={b.color} seed={b.id} size={28} /> : null;
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="max-h-[85vh] overflow-y-auto rounded-3xl sm:max-w-lg"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle>{t('today.title')}</DialogTitle>
        </DialogHeader>
        {!data ? (
          <div className="flex justify-center py-10 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          // A grid item is as wide as its longest line by default; long summaries would push it sideways.
          <div className="min-w-0 space-y-5 text-sm">
            <p className="text-muted-foreground">
              {t('today.summary', {
                turns: data.bots.reduce((n, b) => n + b.turns, 0),
                runs: data.runs.length,
                cost: f.usd(data.costUsd),
              })}
            </p>
            <Section
              title={t('today.waiting')}
              empty={t('today.waitingNone')}
              items={waiting}
              extra={
                <>
                  {/* Memory changes asked for while nobody watched wait for the person's yes. */}
                  {data.pendingMemory ? (
                    <Item
                      onClick={() => {
                        useUi.getState().openSettings('memory');
                        setOpen(false);
                      }}
                    >
                      <Brain className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">
                        {t('today.pendingMemory', { count: data.pendingMemory })}
                      </span>
                      <span className="shrink-0 text-xs font-medium text-amber-600 dark:text-amber-400">
                        {t('today.pendingMemoryReview')}
                      </span>
                    </Item>
                  ) : null}
                  {/* Notes no bot uses wait for the person to keep or delete them in the memory screen. */}
                  {data.staleMemory ? (
                    <Item
                      onClick={() => {
                        useUi.getState().openSettings('memory');
                        setOpen(false);
                      }}
                    >
                      <Brain className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">
                        {t('today.staleMemory', { count: data.staleMemory })}
                      </span>
                      <span className="shrink-0 text-xs font-medium text-amber-600 dark:text-amber-400">
                        {t('today.staleMemoryReview')}
                      </span>
                    </Item>
                  ) : null}
                </>
              }
            >
              {(s) => (
                <Item key={s.botId} onClick={() => go(s.botId, s.waiting!.threadId)}>
                  {avatar(s.botId)}
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{byId.get(s.botId)?.name}</span>{' '}
                    <span className="text-muted-foreground">{s.waiting!.summary}</span>
                  </span>
                  <span className="shrink-0 text-xs font-medium text-amber-600 dark:text-amber-400">
                    {t(`sidebar.waitingFor.${s.waiting!.kind}`)}
                  </span>
                </Item>
              )}
            </Section>
            <Section title={t('today.bots')} empty={t('today.botsNone')} items={data.bots}>
              {(b: TodayReport['bots'][number]) => (
                <Item key={b.botId} onClick={() => go(b.botId)}>
                  {avatar(b.botId)}
                  <span className="min-w-0 flex-1 truncate font-medium">{b.name}</span>
                  {b.failed > 0 && (
                    <span className="shrink-0 text-xs text-destructive">
                      {t('today.failed', { count: b.failed })}
                    </span>
                  )}
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {t('usage.turnCount', { count: b.turns })}
                  </span>
                </Item>
              )}
            </Section>
            <Section title={t('today.runs')} empty={t('today.runsNone')} items={data.runs}>
              {(r: TodayReport['runs'][number]) => (
                <Item key={`${r.routineId}:${r.startedAt}`} onClick={() => go(r.botId, r.threadId)}>
                  <RunIcon status={r.status} />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{r.name}</span>{' '}
                    <span className="text-muted-foreground">{byId.get(r.botId)?.name}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {f.shortTime(r.startedAt)}
                  </span>
                </Item>
              )}
            </Section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Section<T>({
  title,
  empty,
  items,
  extra,
  children,
}: {
  title: string;
  empty: string;
  items: T[];
  /** A line after the items, not one of them. */
  extra?: React.ReactNode;
  children: (item: T) => React.ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-1.5 px-1 text-xs font-medium text-muted-foreground">{title}</h3>
      {items.length || extra ? (
        <div className="divide-y rounded-2xl border bg-card/50">
          {items.map(children)}
          {extra}
        </div>
      ) : (
        <p className="px-1 text-muted-foreground">{empty}</p>
      )}
    </section>
  );
}

function Item({ onClick, children }: { onClick(): void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 px-3 py-2 text-left first:rounded-t-2xl last:rounded-b-2xl hover:bg-accent/50"
    >
      {children}
    </button>
  );
}

function RunIcon({ status }: { status: TodayReport['runs'][number]['status'] }) {
  const cls = 'size-4 shrink-0';
  if (status === 'done') return <CircleCheck className={cn(cls, 'text-emerald-500')} />;
  if (status === 'error') return <CircleAlert className={cn(cls, 'text-destructive')} />;
  return <Clock className={cn(cls, 'text-muted-foreground')} />;
}
