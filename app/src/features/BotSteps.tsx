import type { Bot } from '@yumakbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lightbulb } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import { api } from '@/lib/api';

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
