import type { Bot, WhatsAppMode, WhatsAppStatus } from '@yumakbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useT, type MessageKey } from '@/i18n';
import { api } from '@/lib/api';
import { useBots } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Card } from './SettingsDialog';
import { EmailCard } from './EmailCard';
import { DiscordCard } from './DiscordCard';
import { SlackCard } from './SlackCards';

const ERRORS: Record<string, MessageKey> = {
  expired: 'whatsapp.error.expired',
  ownNumber: 'whatsapp.error.ownNumber',
  loggedOut: 'whatsapp.error.loggedOut',
  forbidden: 'whatsapp.error.forbidden',
  mismatch: 'whatsapp.error.mismatch',
  replaced: 'whatsapp.error.replaced',
  unreachable: 'whatsapp.error.unreachable',
  failing: 'whatsapp.error.failing',
};

/**
 * Chat apps: WhatsApp for the chosen bot and the server's Slack app and Discord bot here; each bot's
 * Telegram is in that bot's settings.
 */
export function ChannelsTab() {
  const t = useT();
  return (
    <>
      <WhatsAppCard />
      <SlackCard />
      <DiscordCard />
      <Card title={t('channels.telegram')}>
        <p className="px-4 py-3 text-sm text-muted-foreground">{t('channels.telegramHint')}</p>
      </Card>
      <EmailCard />
    </>
  );
}

function WhatsAppCard() {
  const { data: status } = useQuery({ queryKey: ['whatsapp'], queryFn: api.whatsapp });
  const { data: bots } = useBots();
  if (!status || !bots) return null;
  // The form starts again from what is saved whenever that changes (saved, or disconnected).
  return <WhatsAppForm key={`${status.mode}:${status.phone}:${status.botId}`} status={status} bots={bots} />;
}

function WhatsAppForm({ status, bots }: { status: WhatsAppStatus; bots: Bot[] }) {
  const t = useT();
  const qc = useQueryClient();
  const live = bots.filter((b) => !b.archivedAt);
  const [mode, setMode] = useState<WhatsAppMode>(status.mode ?? 'separate');
  const [phone, setPhone] = useState(status.phone ?? '');
  const [botId, setBotId] = useState(status.botId ?? live.find((b) => b.isManager)?.id ?? live[0]?.id ?? '');
  const [notices, setNotices] = useState(status.notices);
  const put = (s: WhatsAppStatus) => qc.setQueryData(['whatsapp'], s);
  const save = useMutation({
    mutationFn: () => api.setWhatsapp({ mode, phone, botId: botId || null, notices }),
    onSuccess: (s) => {
      put(s);
      toast.success(t('whatsapp.saved'));
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const link = useMutation({
    mutationFn: async () => {
      // What is in the form is what the new link is for.
      await api.setWhatsapp({ mode, phone, botId: botId || null, notices });
      return api.linkWhatsapp();
    },
    onSuccess: put,
    onError: (e) => toast.error((e as Error).message),
  });
  const disconnect = useMutation({
    mutationFn: api.disconnectWhatsapp,
    onSuccess: put,
    onError: (e) => toast.error((e as Error).message),
  });
  const state = status.state;
  const error = status.error ? (ERRORS[status.error] ? t(ERRORS[status.error]!) : status.error) : null;

  return (
    <Card title={t('whatsapp.title')}>
      <div className="space-y-4 px-4 py-4">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'size-2 rounded-full',
              state === 'connected'
                ? 'bg-emerald-500'
                : state === 'error'
                  ? 'bg-destructive'
                  : 'bg-muted-foreground/40',
            )}
          />
          <span className="text-sm">{t(`whatsapp.state.${state}`)}</span>
          {status.linked && <span className="text-xs text-muted-foreground">+{status.linked}</span>}
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="grid gap-2 sm:grid-cols-2">
          {(['separate', 'own'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                'rounded-2xl border px-4 py-3 text-left',
                mode === m ? 'border-primary bg-primary/5' : 'bg-card/50',
              )}
            >
              <span className="block text-sm font-medium">{t(`whatsapp.mode.${m}`)}</span>
              <span className="block text-xs text-muted-foreground">{t(`whatsapp.modeHint.${m}`)}</span>
            </button>
          ))}
        </div>
        <label className="block space-y-1">
          <span className="text-sm font-medium">{t('whatsapp.phone')}</span>
          <Input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            inputMode="tel"
            placeholder="905321234567"
            className="rounded-xl"
          />
          <span className="block text-xs text-muted-foreground">{t(`whatsapp.phoneHint.${mode}`)}</span>
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">{t('whatsapp.bot')}</span>
          <Select value={botId} onValueChange={setBotId}>
            <SelectTrigger className="w-full rounded-xl">
              <SelectValue placeholder={t('whatsapp.botPick')} />
            </SelectTrigger>
            <SelectContent>
              {live.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="block text-xs text-muted-foreground">{t('whatsapp.botHint')}</span>
        </label>
        <label className="flex items-center justify-between gap-4">
          <span>
            <span className="block text-sm">{t('whatsapp.notices')}</span>
            <span className="block text-xs text-muted-foreground">{t('whatsapp.noticesHint')}</span>
          </span>
          <Switch checked={notices} onCheckedChange={setNotices} />
        </label>

        {state === 'linking' && (
          <div className="flex flex-wrap items-center gap-4 rounded-2xl bg-secondary/60 p-4">
            {status.qr ? (
              <img src={status.qr} alt={t('whatsapp.qrAlt')} className="size-48 rounded-xl bg-white p-1" />
            ) : (
              <div className="grid size-48 place-items-center rounded-xl bg-card text-xs text-muted-foreground">
                {t('whatsapp.qrWaiting')}
              </div>
            )}
            <p className="min-w-0 flex-1 text-sm text-muted-foreground">{t('whatsapp.scan')}</p>
          </div>
        )}
        {state === 'connected' && (
          <p className="rounded-2xl bg-secondary/60 p-4 text-sm text-muted-foreground">
            {t(`whatsapp.howTo.${status.mode ?? mode}`, { number: status.linked ?? '' })}
          </p>
        )}
        <p className="text-xs text-muted-foreground">{t('whatsapp.risk')}</p>

        <div className="flex flex-wrap gap-2">
          {(state === 'off' || state === 'error') && (
            <Button
              type="button"
              className="rounded-full"
              disabled={!phone.trim() || link.isPending}
              onClick={() => link.mutate()}
            >
              {t(state === 'error' ? 'whatsapp.relink' : 'whatsapp.link')}
            </Button>
          )}
          {state !== 'off' && (
            <Button type="button" variant="secondary" className="rounded-full" onClick={() => save.mutate()}>
              {t('common.save')}
            </Button>
          )}
          {state !== 'off' && (
            <Button
              type="button"
              variant="ghost"
              className="rounded-full text-muted-foreground"
              disabled={disconnect.isPending}
              onClick={() => window.confirm(t('whatsapp.disconnectConfirm')) && disconnect.mutate()}
            >
              {t('whatsapp.disconnect')}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
