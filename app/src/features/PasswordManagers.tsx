import type { PasswordManager, PasswordManagerCreate, PasswordManagerKind } from '@yumakbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw, Trash2, Vault } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useManagesServer } from '@/lib/queries';
import { BotAccess, TeamChoice } from './VaultTab';

/** The products' own names, the same in every language. */
const NAMES: Record<PasswordManagerKind, string> = {
  onepassword: '1Password',
  bitwarden: 'Bitwarden',
  protonpass: 'Proton Pass',
};
const KINDS = Object.keys(NAMES) as PasswordManagerKind[];

/**
 * Password managers the vault reads sign-ins from: bots sign in with what is kept there, without
 * the passwords being copied into the vault. What a manager is connected with is never shown again.
 */
export function PasswordManagers() {
  const t = useT();
  const { data: managers = [] } = useQuery({
    queryKey: ['vault', 'password-managers'],
    queryFn: api.passwordManagers,
  });
  const [adding, setAdding] = useState(false);
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2 px-1">
        <div>
          <div className="text-sm font-medium">{t('passwordManagers.title')}</div>
          <p className="text-xs text-muted-foreground">{t('passwordManagers.hint')}</p>
        </div>
        {!adding && (
          <Button variant="secondary" className="rounded-full" onClick={() => setAdding(true)}>
            <Plus /> {t('passwordManagers.connect')}
          </Button>
        )}
      </div>
      {adding && <ManagerForm taken={managers} onDone={() => setAdding(false)} />}
      {managers.length > 0 && (
        <div className="divide-y rounded-2xl border bg-card/50">
          {managers.map((m) => (
            <ManagerRow key={m.id} manager={m} />
          ))}
        </div>
      )}
    </section>
  );
}

function ManagerRow({ manager: m }: { manager: PasswordManager }) {
  const t = useT();
  const { dayLabel } = useFormat();
  const qc = useQueryClient();
  const manages = useManagesServer();
  const mayChange = manages || !!m.userId;
  const done = () => qc.invalidateQueries({ queryKey: ['vault', 'password-managers'] });
  const refresh = useMutation({
    mutationFn: () => api.refreshPasswordManager(m.id),
    onSuccess: done,
    onError: (e) => toast.error((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: () => api.removePasswordManager(m.id),
    onSuccess: done,
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border bg-background text-muted-foreground">
        <Vault className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">
          {NAMES[m.kind]}
          {m.scope ? ` · ${m.scope}` : ''}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {m.userId === null ? t('owned.team') : t('owned.yours')}
          {m.count !== null ? ` · ${t('passwordManagers.count', { count: m.count })}` : ''}
          {m.botIds ? ` · ${t('vault.someBots', { count: m.botIds.length })}` : ''}
          {m.readAt ? ` · ${t('passwordManagers.readAt', { when: dayLabel(m.readAt) })}` : ''}
        </div>
        {m.problem && (
          <div className="text-xs text-destructive">{t(`passwordManagers.problem.${m.problem}`)}</div>
        )}
      </div>
      {mayChange && (
        <>
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full"
            disabled={refresh.isPending}
            onClick={() => refresh.mutate()}
            aria-label={t('passwordManagers.refresh')}
            title={t('passwordManagers.refresh')}
          >
            <RefreshCw className={refresh.isPending ? 'animate-spin' : undefined} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full"
            disabled={remove.isPending}
            onClick={() => {
              if (confirm(t('passwordManagers.confirmDelete', { name: NAMES[m.kind] }))) remove.mutate();
            }}
            aria-label={t('common.delete')}
          >
            <Trash2 />
          </Button>
        </>
      )}
    </div>
  );
}

function ManagerForm({ taken, onDone }: { taken: PasswordManager[]; onDone(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const manages = useManagesServer();
  const [kind, setKind] = useState<PasswordManagerKind>('onepassword');
  const [token, setToken] = useState('');
  const [scope, setScope] = useState('');
  const [server, setServer] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [password, setPassword] = useState('');
  const [botIds, setBotIds] = useState<string[] | null>(null);
  const [team, setTeam] = useState(false);
  const connect = useMutation({
    mutationFn: () => {
      const shared = { scope: scope.trim(), botIds, ...(manages && team && { team }) };
      const body: PasswordManagerCreate =
        kind === 'bitwarden'
          ? {
              kind,
              clientId: clientId.trim(),
              clientSecret: clientSecret.trim(),
              password,
              ...(server.trim() && { server: server.trim() }),
              ...shared,
            }
          : { kind, token: token.trim(), ...shared };
      return api.addPasswordManager(body);
    },
    onSuccess: (m) => {
      void qc.invalidateQueries({ queryKey: ['vault', 'password-managers'] });
      toast.success(t('passwordManagers.connected', { name: NAMES[m.kind], count: m.count ?? 0 }));
      onDone();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    connect.mutate();
  };
  const ready =
    kind === 'bitwarden'
      ? !!(clientId.trim() && clientSecret.trim() && password && scope.trim())
      : token.trim().length >= 20;
  // One of each kind per owner: a kind already connected for oneself is not offered again.
  const own = new Set(taken.filter((m) => m.userId !== null).map((m) => m.kind));
  return (
    <form onSubmit={submit} className="space-y-3 rounded-2xl border bg-background p-3">
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('passwordManagers.kind')}>
        {KINDS.map((k) => (
          <Button
            key={k}
            type="button"
            role="radio"
            aria-checked={kind === k}
            variant={kind === k ? 'default' : 'secondary'}
            className="rounded-full"
            disabled={own.has(k) && !team}
            onClick={() => setKind(k)}
          >
            {NAMES[k]}
          </Button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{t(`passwordManagers.how.${kind}`)}</p>
      {kind === 'bitwarden' ? (
        <>
          <Input
            value={server}
            onChange={(e) => setServer(e.target.value)}
            placeholder={t('passwordManagers.server')}
            aria-label={t('passwordManagers.server')}
            inputMode="url"
          />
          <div className="flex gap-2">
            <Input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder={t('passwordManagers.clientId')}
              aria-label={t('passwordManagers.clientId')}
              autoComplete="off"
            />
            <Input
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={t('passwordManagers.clientSecret')}
              aria-label={t('passwordManagers.clientSecret')}
              autoComplete="off"
            />
          </div>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t('passwordManagers.masterPassword')}
            aria-label={t('passwordManagers.masterPassword')}
            autoComplete="off"
          />
        </>
      ) : (
        <Input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={t(`passwordManagers.token.${kind}`)}
          aria-label={t(`passwordManagers.token.${kind}`)}
          autoComplete="off"
        />
      )}
      <Input
        value={scope}
        onChange={(e) => setScope(e.target.value)}
        placeholder={t(kind === 'bitwarden' ? 'passwordManagers.folder' : 'passwordManagers.vaultName')}
        aria-label={t(kind === 'bitwarden' ? 'passwordManagers.folder' : 'passwordManagers.vaultName')}
      />
      <BotAccess botIds={botIds} onChange={setBotIds} />
      {manages && <TeamChoice team={team} onChange={setTeam} />}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" className="rounded-full" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" className="rounded-full" disabled={!ready || connect.isPending}>
          {connect.isPending ? t('passwordManagers.checking') : t('passwordManagers.connect')}
        </Button>
      </div>
    </form>
  );
}
