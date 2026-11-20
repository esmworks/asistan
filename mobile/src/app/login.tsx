import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, ErrorText, Field, FormScreen, Hint, Mark, Title, type FieldHandle } from '@/components/ui';
import { t } from '@/i18n';
import { hostOf } from '@/lib/address';
import { ApiError } from '@/lib/api';
import { useApi, useServer } from '@/lib/server';

/**
 * Sign-in: username and password once the server has an account, the access key before that
 * (and whenever the password is forgotten). Older servers without accounts get the key alone.
 */
export default function Login() {
  const { origin } = useServer();
  const api = useApi();
  const session = useQuery({ queryKey: ['session', origin], queryFn: api.session });
  const [useKey, setUseKey] = useState(false);
  const [useCode, setUseCode] = useState(false);
  const hasAccount = !!session.data?.account;
  const password = hasAccount && !useKey && !useCode;

  return (
    <FormScreen>
      <Mark />
      <Title>Leaf Bot</Title>
      <Hint>{useCode ? t('login.codeHint') : password ? t('login.accountHint') : t('login.hint')}</Hint>
      {useCode ? <CodeForm /> : password ? <PasswordForm /> : <KeyForm />}
      {hasAccount && !useCode ? (
        <Button
          label={useKey ? t('login.usePassword') : t('login.useKey')}
          variant="ghost"
          onPress={() => setUseKey((v) => !v)}
        />
      ) : null}
      <Button
        label={useCode ? t('login.back') : t('login.useCode')}
        variant="ghost"
        onPress={() => setUseCode((v) => !v)}
      />
      <View style={styles.server}>
        <Hint>{t('login.server', { host: origin ? hostOf(origin) : '' })}</Hint>
        <Button label={t('login.otherServer')} variant="ghost" onPress={() => router.push('/connect')} />
      </View>
    </FormScreen>
  );
}

/** After a sign-in: the session is fresh, so the first screen sends on to the bots. */
function useSignedIn() {
  const queryClient = useQueryClient();
  return async () => {
    await queryClient.resetQueries();
    router.replace('/');
  };
}

function failure(e: unknown): string {
  return e instanceof ApiError ? e.message : t('login.unreachable');
}

function PasswordForm() {
  const api = useApi();
  const signedIn = useSignedIn();
  const passwordRef = useRef<FieldHandle>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<{ field: 'username' | 'password'; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!username.trim()) return setError({ field: 'username', message: t('login.enterUsername') });
    if (!password) return setError({ field: 'password', message: t('login.enterPassword') });
    setError(null);
    setBusy(true);
    try {
      await api.login(username.trim(), password);
      await signedIn();
    } catch (e) {
      setError({ field: 'password', message: failure(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Field
        value={username}
        onChangeText={(v) => {
          setUsername(v);
          if (error?.field === 'username') setError(null);
        }}
        placeholder={t('login.username')}
        accessibilityLabel={t('login.username')}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="username"
        textContentType="username"
        returnKeyType="next"
        autoFocus
        invalid={error?.field === 'username'}
        onSubmitEditing={() => passwordRef.current?.focus()}
        submitBehavior="submit"
      />
      <Field
        ref={passwordRef}
        value={password}
        onChangeText={(v) => {
          setPassword(v);
          if (error?.field === 'password') setError(null);
        }}
        placeholder={t('login.password')}
        accessibilityLabel={t('login.password')}
        secureTextEntry
        autoComplete="current-password"
        textContentType="password"
        returnKeyType="go"
        invalid={error?.field === 'password'}
        onSubmitEditing={() => void submit()}
      />
      {error ? <ErrorText>{error.message}</ErrorText> : null}
      <Button label={t('login.submit')} busy={busy} onPress={() => void submit()} />
    </>
  );
}

/** A one-time code from a device already signed in (Settings → Connection). */
function CodeForm() {
  const api = useApi();
  const signedIn = useSignedIn();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!code.trim()) return setError(t('login.enterCode'));
    setError(null);
    setBusy(true);
    try {
      await api.pair(code.trim());
      await signedIn();
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Field
        value={code}
        onChangeText={(v) => {
          setCode(v);
          setError(null);
        }}
        placeholder={t('login.code')}
        accessibilityLabel={t('login.code')}
        autoCapitalize="characters"
        autoCorrect={false}
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        returnKeyType="go"
        autoFocus
        invalid={!!error}
        onSubmitEditing={() => void submit()}
      />
      {error ? <ErrorText>{error}</ErrorText> : null}
      <Button label={t('login.submit')} busy={busy} onPress={() => void submit()} />
    </>
  );
}

function KeyForm() {
  const api = useApi();
  const signedIn = useSignedIn();
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!key.trim()) return setError(t('login.enterKey'));
    setError(null);
    setBusy(true);
    try {
      await api.access(key.trim());
      await signedIn();
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Field
        value={key}
        onChangeText={(v) => {
          setKey(v);
          setError(null);
        }}
        placeholder={t('login.key')}
        accessibilityLabel={t('login.key')}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="current-password"
        textContentType="password"
        returnKeyType="go"
        autoFocus
        invalid={!!error}
        onSubmitEditing={() => void submit()}
      />
      {error ? <ErrorText>{error}</ErrorText> : null}
      <Button label={t('login.submit')} busy={busy} onPress={() => void submit()} />
    </>
  );
}

const styles = StyleSheet.create({ server: { marginTop: 24 } });
