import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, ErrorText, Field, FormScreen, Hint, Mark, Title } from '@/components/ui';
import { t } from '@/i18n';
import { ApiError } from '@/lib/api';
import { useApi, useServer } from '@/lib/server';
import { View } from 'react-native';

/**
 * Makes the sign-in account (username and password), or changes it.
 *
 * `AccountForm` props:
 * - `username`: what the username box starts with.
 * - `change`: true when an account exists; the form then also asks for the current password (or
 *   the access key, when the password is forgotten).
 * - `onDone(username)`: called after the server saved it.
 *
 * `CreateAccount` is the whole screen shown right after the first sign-in with the access key;
 * `onDone` is called when the account is made, or when the person picks "later".
 */

/** As the server requires. */
const MIN_PASSWORD = 8;

export function AccountForm({
  username = '',
  change = false,
  onDone,
}: {
  username?: string;
  change?: boolean;
  onDone: (username: string) => void;
}) {
  const api = useApi();
  const { origin } = useServer();
  const qc = useQueryClient();
  const [name, setName] = useState(username);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [current, setCurrent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const problem = !name.trim()
      ? t('login.enterUsername')
      : password.length < MIN_PASSWORD
        ? t('account.passwordShort', { min: String(MIN_PASSWORD) })
        : password !== repeat
          ? t('account.mismatch')
          : change && !current
            ? t('account.enterCurrent')
            : null;
    setError(problem);
    if (problem) return;
    setBusy(true);
    try {
      const saved = await api.setAccount({
        username: name.trim(),
        password,
        ...(change ? { current } : {}),
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['account', origin] }),
        qc.invalidateQueries({ queryKey: ['session', origin] }),
      ]);
      onDone(saved.username);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('login.unreachable'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: 12 }}>
      <Field
        value={name}
        onChangeText={setName}
        autoCapitalize="none"
        autoCorrect={false}
        textContentType="username"
        placeholder={t('login.username')}
        accessibilityLabel={t('login.username')}
      />
      <Field
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        textContentType="newPassword"
        placeholder={change ? t('account.newPassword') : t('login.password')}
        accessibilityLabel={change ? t('account.newPassword') : t('login.password')}
      />
      <Field
        value={repeat}
        onChangeText={setRepeat}
        secureTextEntry
        textContentType="newPassword"
        placeholder={t('account.repeat')}
        accessibilityLabel={t('account.repeat')}
      />
      {change ? (
        <Field
          value={current}
          onChangeText={setCurrent}
          secureTextEntry
          autoCapitalize="none"
          textContentType="password"
          placeholder={t('account.current')}
          accessibilityLabel={t('account.current')}
        />
      ) : null}
      {error ? <ErrorText>{error}</ErrorText> : null}
      <Button
        label={change ? t('account.save') : t('account.create')}
        onPress={() => void submit()}
        busy={busy}
      />
    </View>
  );
}

export function CreateAccount({ onDone }: { onDone: () => void }) {
  return (
    <FormScreen>
      <Mark />
      <Title>{t('account.createTitle')}</Title>
      <Hint>{t('account.createBody')}</Hint>
      <AccountForm onDone={onDone} />
      <Button variant="ghost" label={t('account.later')} onPress={onDone} />
    </FormScreen>
  );
}
