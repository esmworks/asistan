import type { ApiAuth, ApiCredential } from '@yumakbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeySquare, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { BotAccess } from './VaultTab';

type AuthType = ApiAuth['type'];

/**
 * API keys bots call services with. Listed without their values: a key only ever goes from the
 * server to its own address, added to a request the bot names it in.
 */
export function ApiKeys() {
  const t = useT();
  const { data: keys = [] } = useQuery({ queryKey: ['api-keys'], queryFn: api.apiKeys });
  const [editing, setEditing] = useState<ApiCredential | 'new' | null>(null);
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2 px-1">
        <h3 className="flex-1 text-sm font-medium">{t('apiKeys.title')}</h3>
        <Button size="sm" variant="secondary" className="rounded-full" onClick={() => setEditing('new')}>
          <Plus /> {t('common.add')}
        </Button>
      </div>
      {editing === 'new' && <KeyForm onDone={() => setEditing(null)} />}
      <div className="divide-y rounded-2xl border bg-card/50">
        {!keys.length && (
          <div className="flex flex-col items-center gap-2 px-6 py-8 text-center text-sm text-muted-foreground">
            <KeySquare className="size-6" />
            {t('apiKeys.empty')}
          </div>
        )}
        {keys.map((k) =>
          editing !== 'new' && editing?.id === k.id ? (
            <div key={k.id} className="p-3">
              <KeyForm current={k} onDone={() => setEditing(null)} />
            </div>
          ) : (
            <KeyRow key={k.id} k={k} onEdit={() => setEditing(k)} />
          ),
        )}
      </div>
      <p className="px-1 text-xs text-muted-foreground">{t('apiKeys.note')}</p>
    </section>
  );
}

function KeyRow({ k, onEdit }: { k: ApiCredential; onEdit(): void }) {
  const t = useT();
  const { dayLabel } = useFormat();
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.removeApiKey(k.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['api-keys'] }),
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <KeySquare className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">
          {k.name}
          {k.label && <span className="font-normal text-muted-foreground"> · {k.label}</span>}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {k.origin}
          {k.botIds ? ` · ${t('vault.someBots', { count: k.botIds.length })}` : ''}
          {k.lastUsedAt ? ` · ${t('vault.lastUsed', { when: dayLabel(k.lastUsedAt) })}` : ''}
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
          if (confirm(t('apiKeys.confirmDelete', { name: k.name }))) remove.mutate();
        }}
        aria-label={t('common.delete')}
      >
        <Trash2 />
      </Button>
    </div>
  );
}

/** Adds a key, or edits one; the value is only sent when typed. */
function KeyForm({ current, onDone }: { current?: ApiCredential; onDone(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState(current?.name ?? '');
  const [origin, setOrigin] = useState(current?.origin ?? '');
  const [label, setLabel] = useState(current?.label ?? '');
  const [value, setValue] = useState('');
  const [type, setType] = useState<AuthType>(current?.auth.type ?? 'bearer');
  const a = current?.auth;
  const [extra, setExtra] = useState(
    a?.type === 'header' ? a.header : a?.type === 'query' ? a.param : a?.type === 'basic' ? a.username : '',
  );
  const [botIds, setBotIds] = useState<string[] | null>(current?.botIds ?? null);
  const auth = (): ApiAuth =>
    type === 'header'
      ? { type, header: extra.trim() }
      : type === 'query'
        ? { type, param: extra.trim() }
        : type === 'basic'
          ? { type, username: extra }
          : { type };
  const save = useMutation({
    mutationFn: () =>
      current
        ? api.updateApiKey(current.id, { origin, label, auth: auth(), botIds, ...(value && { value }) })
        : api.addApiKey({ name, origin, label, auth: auth(), value, botIds }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['api-keys'] });
      onDone();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  const extraLabel =
    type === 'header' ? t('apiKeys.header') : type === 'query' ? t('apiKeys.param') : t('apiKeys.username');
  return (
    <form onSubmit={submit} className="space-y-2 rounded-2xl border bg-background p-3">
      <div className="flex gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('apiKeys.name')}
          aria-label={t('apiKeys.name')}
          disabled={!!current}
          required
          className="w-40"
        />
        <Input
          value={origin}
          onChange={(e) => setOrigin(e.target.value)}
          placeholder={t('apiKeys.origin')}
          aria-label={t('apiKeys.origin')}
          required
        />
      </div>
      <Input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder={t('apiKeys.label')}
        aria-label={t('apiKeys.label')}
      />
      <div className="flex gap-2">
        <Select value={type} onValueChange={(v) => setType(v as AuthType)}>
          <SelectTrigger className="w-48" aria-label={t('apiKeys.how')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="bearer">{t('apiKeys.how.bearer')}</SelectItem>
            <SelectItem value="header">{t('apiKeys.how.header')}</SelectItem>
            <SelectItem value="query">{t('apiKeys.how.query')}</SelectItem>
            <SelectItem value="basic">{t('apiKeys.how.basic')}</SelectItem>
          </SelectContent>
        </Select>
        {type !== 'bearer' && (
          <Input
            value={extra}
            onChange={(e) => setExtra(e.target.value)}
            placeholder={extraLabel}
            aria-label={extraLabel}
            required={type !== 'basic'}
          />
        )}
      </div>
      <Input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={current ? t('apiKeys.newValue') : t('apiKeys.value')}
        aria-label={t('apiKeys.value')}
        autoComplete="new-password"
        required={!current}
      />
      <BotAccess botIds={botIds} onChange={setBotIds} />
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" className="rounded-full" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" className="rounded-full" disabled={save.isPending}>
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
}
