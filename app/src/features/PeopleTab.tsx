import type { PersonInfo } from '@yumakbot/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, Trash2, UserRound } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useManagesServer, usePeople, useSession } from '@/lib/queries';

/** The shortest password the server takes. */
const MIN_PASSWORD = 8;

/** A person's name as the lists show it. */
export function personName(p: Pick<PersonInfo, 'displayName' | 'username'>, owner: string) {
  return p.displayName || p.username || owner;
}

/**
 * The people on this server. Everyone sees who is here; those who look after the server add,
 * change and remove them. Only the owner handles admins, and nobody changes themselves here.
 */
export function PeopleTab() {
  const t = useT();
  const { data: people = [] } = usePeople();
  const manages = useManagesServer();
  const [adding, setAdding] = useState(false);
  return (
    <div className="space-y-4">
      <p className="px-1 text-sm text-muted-foreground">{t('people.intro')}</p>
      {manages && !adding && (
        <Button className="rounded-full" onClick={() => setAdding(true)}>
          <Plus /> {t('people.add')}
        </Button>
      )}
      {adding && <NewPerson onDone={() => setAdding(false)} />}
      <div className="divide-y rounded-2xl border bg-card/50">
        {people.map((p) => (
          <PersonRow key={p.id} person={p} />
        ))}
      </div>
    </div>
  );
}

function PersonRow({ person }: { person: PersonInfo }) {
  const t = useT();
  const qc = useQueryClient();
  const me = useSession().data?.user;
  const [resetting, setResetting] = useState(false);
  const isMe = me?.id === person.id;
  // The owner stays as they are; admins are the owner's to change.
  const mayChange =
    !isMe &&
    person.role !== 'owner' &&
    (me?.role === 'owner' || (me?.role === 'admin' && person.role === 'member'));
  const done = () => void qc.invalidateQueries({ queryKey: ['people'] });
  const change = useMutation({
    mutationFn: (patch: Parameters<typeof api.updatePerson>[1]) => api.updatePerson(person.id, patch),
    onSuccess: done,
    onError: (e) => toast.error((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: () => api.removePerson(person.id),
    onSuccess: () => {
      done();
      void qc.invalidateQueries({ queryKey: ['bots'] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const name = personName(person, t('people.owner'));
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border bg-background text-muted-foreground">
          <UserRound className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {name}
            {isMe ? ` · ${t('people.you')}` : ''}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {person.username && person.displayName ? `${person.username} · ` : ''}
            {t(`people.role.${person.role}`)}
            {person.disabled ? ` · ${t('people.disabled')}` : ''}
          </div>
        </div>
        {mayChange && (
          <>
            <Select
              value={person.role}
              onValueChange={(role) => change.mutate({ role: role as 'admin' | 'member' })}
              disabled={me?.role !== 'owner'}
            >
              <SelectTrigger className="w-32 rounded-full" aria-label={t('people.roleLabel')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">{t('people.role.member')}</SelectItem>
                <SelectItem value="admin">{t('people.role.admin')}</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="ghost"
              size="icon"
              className="rounded-full"
              onClick={() => setResetting((r) => !r)}
              aria-label={t('people.resetPassword')}
              title={t('people.resetPassword')}
            >
              <KeyRound />
            </Button>
            <Button
              variant="ghost"
              className="rounded-full"
              disabled={change.isPending}
              onClick={() => {
                if (person.disabled || confirm(t('people.confirmDisable', { name })))
                  change.mutate({ disabled: !person.disabled });
              }}
            >
              {person.disabled ? t('people.enable') : t('people.disable')}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="rounded-full"
              disabled={remove.isPending}
              onClick={() => {
                if (confirm(t('people.confirmRemove', { name }))) remove.mutate();
              }}
              aria-label={t('common.delete')}
            >
              <Trash2 />
            </Button>
          </>
        )}
      </div>
      {resetting && (
        <NewPassword
          onSave={(password) => change.mutate({ password }, { onSuccess: () => setResetting(false) })}
          onCancel={() => setResetting(false)}
          pending={change.isPending}
        />
      )}
    </div>
  );
}

function NewPassword({
  onSave,
  onCancel,
  pending,
}: {
  onSave(password: string): void;
  onCancel(): void;
  pending: boolean;
}) {
  const t = useT();
  const [password, setPassword] = useState('');
  return (
    <form
      className="mt-3 flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(password);
      }}
    >
      <Input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder={t('people.newPassword', { min: String(MIN_PASSWORD) })}
        aria-label={t('people.resetPassword')}
        autoComplete="new-password"
        className="flex-1"
      />
      <Button type="button" variant="ghost" className="rounded-full" onClick={onCancel}>
        {t('common.cancel')}
      </Button>
      <Button type="submit" className="rounded-full" disabled={pending || password.length < MIN_PASSWORD}>
        {t('common.save')}
      </Button>
    </form>
  );
}

function NewPerson({ onDone }: { onDone(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const isOwner = useSession().data?.user?.role === 'owner';
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const add = useMutation({
    mutationFn: () =>
      api.addPerson({
        username,
        password,
        role,
        ...(displayName.trim() && { displayName: displayName.trim() }),
      }),
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: ['people'] });
      toast.success(t('people.added', { name: personName(p, '') }));
      onDone();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-2 rounded-2xl border bg-background p-3">
      <Input
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        placeholder={t('people.username')}
        aria-label={t('people.username')}
        autoComplete="off"
        required
      />
      <Input
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        placeholder={t('people.displayName')}
        aria-label={t('people.displayName')}
        autoComplete="off"
      />
      <Input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder={t('people.password', { min: String(MIN_PASSWORD) })}
        aria-label={t('people.passwordLabel')}
        autoComplete="new-password"
        required
      />
      {isOwner && (
        <Select value={role} onValueChange={(r) => setRole(r as 'member' | 'admin')}>
          <SelectTrigger className="w-full rounded-full" aria-label={t('people.roleLabel')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="member">{t('people.role.member')}</SelectItem>
            <SelectItem value="admin">{t('people.role.admin')}</SelectItem>
          </SelectContent>
        </Select>
      )}
      <p className="px-1 text-xs text-muted-foreground">{t('people.passwordHint')}</p>
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" className="rounded-full" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button
          type="submit"
          className="rounded-full"
          disabled={add.isPending || !username.trim() || password.length < MIN_PASSWORD}
        >
          {t('people.add')}
        </Button>
      </div>
    </form>
  );
}
