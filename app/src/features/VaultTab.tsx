import type { VaultLogin } from '@yumakbot/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useBots, useVault } from '@/lib/queries';
import { SharedPages } from './SharedPages';

/** The password vault: saved sign-ins, listed without their passwords. */
export function VaultTab() {
  const t = useT();
  const { data: logins = [], isLoading } = useVault();
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<VaultLogin | 'new' | null>(null);
  const q = query.trim().toLowerCase();
  const shown = q ? logins.filter((l) => l.site.includes(q) || l.username.toLowerCase().includes(q)) : logins;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('vault.search')}
            className="h-10 rounded-full pl-9"
          />
        </div>
        <Button className="rounded-full" onClick={() => setEditing('new')}>
          <Plus /> {t('common.add')}
        </Button>
      </div>

      {editing === 'new' && <LoginForm onDone={() => setEditing(null)} />}

      <div className="divide-y rounded-2xl border bg-card/50">
        {!isLoading && shown.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center text-sm text-muted-foreground">
            <KeyRound className="size-6" />
            {q ? t('vault.noMatch') : t('vault.empty')}
          </div>
        )}
        {shown.map((l) =>
          editing !== 'new' && editing?.id === l.id ? (
            <div key={l.id} className="p-3">
              <LoginForm login={l} onDone={() => setEditing(null)} />
            </div>
          ) : (
            <LoginRow key={l.id} login={l} onEdit={() => setEditing(l)} />
          ),
        )}
      </div>
      <p className="px-1 text-xs text-muted-foreground">{t('vault.note')}</p>
      <SharedPages />
    </div>
  );
}

function LoginRow({ login, onEdit }: { login: VaultLogin; onEdit(): void }) {
  const t = useT();
  const { dayLabel } = useFormat();
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.removeVaultLogin(login.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vault'] }),
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border bg-background text-sm font-semibold text-muted-foreground uppercase">
        {login.site[0]}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{login.site}</div>
        <div className="truncate text-xs text-muted-foreground">
          {login.username || t('vault.noUsername')}
          {login.hasTotp ? ` · ${t('vault.hasTotp')}` : ''}
          {login.botIds ? ` · ${t('vault.someBots', { count: login.botIds.length })}` : ''}
          {login.lastUsedAt ? ` · ${t('vault.lastUsed', { when: dayLabel(login.lastUsedAt) })}` : ''}
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="rounded-full"
        onClick={onEdit}
        aria-label={t('vault.edit')}
      >
        <Pencil />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="rounded-full"
        disabled={remove.isPending}
        onClick={() => {
          if (confirm(t('vault.confirmDelete', { site: login.site }))) remove.mutate();
        }}
        aria-label={t('common.delete')}
      >
        <Trash2 />
      </Button>
    </div>
  );
}

/** Adds a sign-in, or edits one; the password is only sent when typed. */
function LoginForm({ login, onDone }: { login?: VaultLogin; onDone(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const [site, setSite] = useState(login?.site ?? '');
  const [username, setUsername] = useState(login?.username ?? '');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [clearTotp, setClearTotp] = useState(false);
  const { data: bots = [] } = useBots();
  // Null: every bot may use it.
  const [botIds, setBotIds] = useState<string[] | null>(login?.botIds ?? null);
  const save = useMutation({
    mutationFn: () =>
      login
        ? api.updateVaultLogin(login.id, {
            site,
            username,
            botIds,
            ...(password && { password }),
            ...(totp.trim() ? { totp: totp.trim() } : clearTotp ? { totp: '' } : {}),
          })
        : api.addVaultLogin({ site, username, password, botIds, ...(totp.trim() && { totp: totp.trim() }) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['vault'] });
      onDone();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-2 rounded-2xl border bg-background p-3">
      <Input
        value={site}
        onChange={(e) => setSite(e.target.value)}
        placeholder={t('vault.site')}
        aria-label={t('vault.site')}
        required
      />
      <Input
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        placeholder={t('vault.username')}
        aria-label={t('vault.username')}
        autoComplete="off"
      />
      <Input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder={login ? t('vault.newPassword') : t('vault.password')}
        aria-label={t('vault.password')}
        autoComplete="new-password"
        required={!login}
      />
      <Input
        type="password"
        value={totp}
        onChange={(e) => setTotp(e.target.value)}
        placeholder={login?.hasTotp && !clearTotp ? t('vault.totpKept') : t('vault.totp')}
        aria-label={t('vault.totp')}
        autoComplete="off"
      />
      {login?.hasTotp && (
        <label className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
          <input type="checkbox" checked={clearTotp} onChange={(e) => setClearTotp(e.target.checked)} />
          {t('vault.totpRemove')}
        </label>
      )}
      <div className="space-y-1 rounded-xl border px-3 py-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={botIds === null}
            onChange={(e) => setBotIds(e.target.checked ? null : [])}
          />
          {t('vault.allBots')}
        </label>
        {botIds !== null && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1">
            {bots.map((b) => (
              <label key={b.id} className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={botIds.includes(b.id)}
                  onChange={(e) =>
                    setBotIds((ids) =>
                      e.target.checked ? [...(ids ?? []), b.id] : (ids ?? []).filter((id) => id !== b.id),
                    )
                  }
                />
                {b.name}
              </label>
            ))}
          </div>
        )}
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" className="rounded-full" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" className="rounded-full" disabled={save.isPending || !site.trim()}>
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
}
