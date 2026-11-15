import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { ShapeArt } from '@/components/BotAvatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { api, ApiError } from '@/lib/api';

/** As the server requires. */
const MIN_PASSWORD = 8;

/**
 * Makes the account, or changes it. A change asks for the current password, or the access key
 * when the password is forgotten.
 */
export function AccountForm({
  username = '',
  change = false,
  onDone,
}: {
  username?: string;
  change?: boolean;
  onDone(username: string): void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const Form = useMemo(
    () =>
      z
        .object({
          username: z.string().trim().min(1, t('login.enterUsername')),
          password: z.string().min(MIN_PASSWORD, t('account.passwordShort', { min: String(MIN_PASSWORD) })),
          repeat: z.string(),
          current: z.string(),
        })
        .refine((v) => v.password === v.repeat, { path: ['repeat'], message: t('account.mismatch') })
        .refine((v) => !change || v.current.length > 0, {
          path: ['current'],
          message: t('account.enterCurrent'),
        }),
    [t, change],
  );
  const form = useForm<z.infer<typeof Form>>({
    resolver: zodResolver(Form),
    defaultValues: { username, password: '', repeat: '', current: '' },
  });
  const submit = form.handleSubmit(async (v) => {
    try {
      const saved = await api.setAccount({
        username: v.username,
        password: v.password,
        ...(change ? { current: v.current } : {}),
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['account'] }),
        qc.invalidateQueries({ queryKey: ['session'] }),
      ]);
      onDone(saved.username);
    } catch (e) {
      form.setError(change ? 'current' : 'password', {
        message: e instanceof ApiError ? e.message : t('login.unreachable'),
      });
    }
  });
  const errors = form.formState.errors;
  const error =
    errors.username?.message ?? errors.password?.message ?? errors.repeat?.message ?? errors.current?.message;
  const field = 'h-11 rounded-full px-5';
  return (
    <form onSubmit={submit} className="space-y-3">
      <Input
        {...form.register('username')}
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        placeholder={t('login.username')}
        aria-label={t('login.username')}
        aria-invalid={!!errors.username}
        className={field}
      />
      <Input
        {...form.register('password')}
        type="password"
        autoComplete="new-password"
        placeholder={change ? t('account.newPassword') : t('login.password')}
        aria-label={change ? t('account.newPassword') : t('login.password')}
        aria-invalid={!!errors.password}
        className={field}
      />
      <Input
        {...form.register('repeat')}
        type="password"
        autoComplete="new-password"
        placeholder={t('account.repeat')}
        aria-label={t('account.repeat')}
        aria-invalid={!!errors.repeat}
        className={field}
      />
      {change && (
        <Input
          {...form.register('current')}
          type="password"
          autoComplete="current-password"
          placeholder={t('account.current')}
          aria-label={t('account.current')}
          aria-invalid={!!errors.current}
          className={field}
        />
      )}
      {error && <p className="px-4 text-sm text-destructive">{error}</p>}
      <Button type="submit" className="h-11 w-full rounded-full" disabled={form.formState.isSubmitting}>
        {form.formState.isSubmitting && <Loader2 className="animate-spin" />}
        {change ? t('account.save') : t('account.create')}
      </Button>
    </form>
  );
}

/** Right after the first sign-in with the access key: the username and password used from then on. */
export function CreateAccount({ onDone }: { onDone(): void }) {
  const t = useT();
  return (
    <div className="flex h-full flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="size-16">
            <ShapeArt shape="blob" color="var(--brand)" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('account.createTitle')}</h1>
          <p className="text-sm text-muted-foreground">{t('account.createBody')}</p>
        </div>
        <AccountForm onDone={onDone} />
        <Button variant="ghost" size="sm" className="w-full" onClick={onDone}>
          {t('account.later')}
        </Button>
      </div>
    </div>
  );
}
