import type { Bot, BotAction } from '@yumakbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Lightbulb } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useT, type MessageKey } from '@/i18n';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useConnections } from '@/lib/queries';
import { ruleLabel } from '@/lib/ruleLabel';
import { useUi } from '@/lib/store';

/** The steps the panel shows before "Show all". */
const PANEL_STEPS = 5;
/** The steps the full list shows; the spreadsheet has every one still kept. */
const ALL_STEPS = 200;

const HOW: Record<BotAction['how'], MessageKey> = {
  card: 'steps.byCard',
  rule: 'steps.byRule',
  level: 'steps.byLevel',
  review: 'steps.byReview',
};

/**
 * Ways to ask less, read from the person's own answers on this bot's cards: a step they always
 * allowed can become an "always allow" rule, and a bot whose cards they nearly always allowed can
 * let the reviewer pass the clearly safe ones. Each is one click, or turned down for good.
 */
export function BotSuggestions({ bot }: { bot: Bot }) {
  const t = useT();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['suggestions', bot.id], queryFn: () => api.suggestions(bot.id) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['suggestions', bot.id] });
  const onError = (e: Error) => toast.error(e.message);
  const allow = useMutation({
    mutationFn: (pattern: string) => api.addRule({ list: 'allow', pattern, botId: bot.id }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['rules'] });
      refresh();
    },
    onError,
  });
  const review = useMutation({
    mutationFn: () => api.updateBot(bot.id, { permissionMode: 'review' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['bots'] });
      refresh();
    },
    onError,
  });
  const dismiss = useMutation({
    mutationFn: (key: string) => api.dismissSuggestion(bot.id, key),
    onSuccess: refresh,
    onError,
  });
  const busy = allow.isPending || review.isPending || dismiss.isPending;
  // An older server has no suggestions to give.
  if (!data || (!data.rules.length && !data.mode)) return null;
  const row = (key: string, text: string, action: React.ReactNode, why?: string) => (
    <div key={key} className="space-y-2 rounded-2xl bg-secondary/60 px-4 py-3">
      <p className="text-sm">{text}</p>
      {why && <p className="text-[13px] text-muted-foreground">{why}</p>}
      <div className="flex flex-wrap gap-2">
        {action}
        <Button
          size="sm"
          variant="ghost"
          className="rounded-full"
          disabled={busy}
          onClick={() => dismiss.mutate(key)}
        >
          {t('suggest.notNow')}
        </Button>
      </div>
    </div>
  );
  return (
    <section>
      <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <Lightbulb className="size-4 text-muted-foreground" aria-hidden />
        {t('suggest.title')}
      </h4>
      <div className="space-y-2">
        {data.mode &&
          row(
            'mode',
            t('suggest.review', { allowed: data.mode.allowed, total: data.mode.allowed + data.mode.denied }),
            <Button size="sm" className="rounded-full" disabled={busy} onClick={() => review.mutate()}>
              {t('suggest.reviewOn')}
            </Button>,
          )}
        {data.rules.map((r) =>
          row(
            r.pattern,
            // A rule narrower than the tool (one command, one folder, one site) says how far it goes.
            r.pattern.includes('(') ? `${r.summary} · ${r.pattern}` : r.summary,
            <Button
              size="sm"
              className="rounded-full"
              disabled={busy}
              onClick={() => allow.mutate(r.pattern)}
            >
              {t('suggest.allow')}
            </Button>,
            t('suggest.rule', { count: r.allowed }),
          ),
        )}
      </div>
    </section>
  );
}

/** The steps the bot was let take lately, and what let each one; a click opens its conversation. */
export function BotSteps({ bot }: { bot: Bot }) {
  const t = useT();
  const [all, setAll] = useState(false);
  const { data: steps = [] } = useQuery({
    queryKey: ['actions', bot.id],
    queryFn: () => api.botActions(bot.id, PANEL_STEPS + 1),
  });
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-sm font-semibold">{t('steps.title')}</h4>
        {steps.length > 0 && (
          <Button size="sm" variant="ghost" className="rounded-full" onClick={() => setAll(true)}>
            {t('steps.showAll')}
          </Button>
        )}
      </div>
      {steps.length === 0 ? (
        <p className="rounded-2xl bg-secondary/60 px-4 py-3 text-sm text-muted-foreground">
          {t('steps.none')}
        </p>
      ) : (
        <StepList steps={steps.slice(0, PANEL_STEPS)} />
      )}
      <AllSteps bot={bot} open={all} onOpenChange={setAll} />
    </section>
  );
}

function AllSteps({
  bot,
  open,
  onOpenChange,
}: {
  bot: Bot;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const t = useT();
  const { data: steps = [] } = useQuery({
    queryKey: ['actions', bot.id, 'all'],
    queryFn: () => api.botActions(bot.id, ALL_STEPS),
    enabled: open,
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto rounded-3xl sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('steps.allTitle', { name: bot.name })}</DialogTitle>
          <DialogDescription>{t('steps.allHint')}</DialogDescription>
        </DialogHeader>
        {steps.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('steps.none')}</p>
        ) : (
          <StepList steps={steps} onOpen={() => onOpenChange(false)} />
        )}
        <Button variant="secondary" size="sm" className="w-fit rounded-full" asChild>
          <a href={`/api/bots/${bot.id}/actions.csv`} download>
            <Download /> {t('steps.downloadCsv')}
          </a>
        </Button>
      </DialogContent>
    </Dialog>
  );
}

function StepList({ steps, onOpen }: { steps: BotAction[]; onOpen?: () => void }) {
  const t = useT();
  const { dayLabel } = useFormat();
  const { data: connections = [] } = useConnections();
  const apps = new Map(connections.map((c) => [c.slug, c.name]));
  const open = (s: BotAction) => {
    if (!s.threadId) return;
    const ui = useUi.getState();
    ui.openChat(s.botId);
    ui.selectThread(s.threadId);
    onOpen?.();
  };
  return (
    <div className="space-y-2">
      {steps.map((s) => {
        const how = t(HOW[s.how], { rule: s.rule ? (ruleLabel(s.rule, t, apps) ?? s.rule) : '' });
        const meta = [how, s.outside ? t('steps.outside') : '', dayLabel(s.createdAt)]
          .filter(Boolean)
          .join(' · ');
        return (
          <button
            key={s.id}
            type="button"
            disabled={!s.threadId}
            onClick={() => open(s)}
            className="block w-full rounded-2xl bg-secondary/60 px-4 py-3 text-left disabled:cursor-default"
          >
            <div className="line-clamp-2 text-sm break-words">{s.summary}</div>
            <div className="truncate text-[13px] text-muted-foreground">{meta}</div>
          </button>
        );
      })}
    </div>
  );
}
