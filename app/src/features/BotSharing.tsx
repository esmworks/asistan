import type { Bot, BotAccess, BotLevel } from '@yumakbot/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useManagesServer, usePeople, useSession } from '@/lib/queries';
import { personName } from './PeopleTab';

/** What a person gets of a bot without a share of their own: what everyone gets. */
const SAME = 'same';

/**
 * Who may use a bot besides its owner: everyone at one level, and some people further. Talking
 * with it keeps each person's conversations their own; changing it reaches its settings, notes
 * and work. Only the bot's owner and those who look after the server share it.
 */
export function BotSharing({ bot }: { bot: Bot }) {
  const t = useT();
  const qc = useQueryClient();
  const me = useSession().data?.user;
  const manages = useManagesServer();
  const { data: people = [] } = usePeople();
  const access: BotAccess = bot.access ?? { everyone: 'none', people: {} };
  const save = useMutation({
    mutationFn: (next: BotAccess) => api.setBotAccess(bot.id, next),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bots'] }),
    onError: (e) => toast.error((e as Error).message),
  });
  // Servers older than people have nobody to share with.
  if (!me || !bot.ownerUserId || !(manages || me.id === bot.ownerUserId)) return null;
  const others = people.filter((p) => p.id !== bot.ownerUserId && !p.disabled);
  const owner = people.find((p) => p.id === bot.ownerUserId);
  const levels: BotLevel[] = ['none', 'chat', 'edit'];
  const setPerson = (id: string, level: string) => {
    const next = { ...access.people };
    if (level === SAME) delete next[id];
    else next[id] = level as 'chat' | 'edit';
    save.mutate({ everyone: access.everyone, people: next });
  };
  return (
    <section className="space-y-2">
      <div>
        <h3 className="text-sm font-medium">{t('share.title')}</h3>
        <p className="text-xs text-muted-foreground">
          {t('share.hint', { owner: owner ? personName(owner, t('people.owner')) : t('people.owner') })}
        </p>
      </div>
      <div className="divide-y rounded-2xl border">
        <div className="flex items-center gap-3 px-4 py-3">
          <span className="min-w-0 flex-1 text-sm">{t('share.everyone')}</span>
          <Select
            value={access.everyone}
            onValueChange={(v) => save.mutate({ everyone: v as BotLevel, people: access.people })}
            disabled={save.isPending}
          >
            <SelectTrigger className="w-44 rounded-full" aria-label={t('share.everyone')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {levels.map((l) => (
                <SelectItem key={l} value={l}>
                  {t(`share.level.${l}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {others.map((p) => {
          const name = personName(p, t('people.owner'));
          return (
            <div key={p.id} className="flex items-center gap-3 px-4 py-3">
              <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
              <Select
                value={access.people[p.id] ?? SAME}
                onValueChange={(v) => setPerson(p.id, v)}
                disabled={save.isPending}
              >
                <SelectTrigger className="w-44 rounded-full" aria-label={name}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SAME}>{t('share.same')}</SelectItem>
                  <SelectItem value="chat">{t('share.level.chat')}</SelectItem>
                  <SelectItem value="edit">{t('share.level.edit')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          );
        })}
      </div>
      {others.length === 0 && <p className="px-1 text-xs text-muted-foreground">{t('share.nobody')}</p>}
    </section>
  );
}
