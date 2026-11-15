import { useQuery } from '@tanstack/react-query';
import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { CreateAccount } from '@/components/settings/connect/AccountSetup';
import { Button, FormScreen, Hint, Title } from '@/components/ui';
import { t } from '@/i18n';
import { hostOf } from '@/lib/address';
import { useBots, useSettings } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';

/** Opens the right screen: the address form, sign-in, or the bots once signed in. */
export default function Start() {
  const { ready, origin } = useServer();
  if (!ready) return <Waiting />;
  if (!origin) return <Redirect href="/connect" />;
  return <Signed origin={origin} />;
}

function Signed({ origin }: { origin: string }) {
  const api = useApi();
  const session = useQuery({ queryKey: ['session', origin], queryFn: api.session });
  if (session.isPending) return <Waiting />;
  if (session.isError) {
    return (
      <FormScreen>
        <Title>{t('offline.title')}</Title>
        <Hint>{t('offline.text', { host: hostOf(origin) })}</Hint>
        <Button label={t('common.retry')} busy={session.isFetching} onPress={() => void session.refetch()} />
        <Button label={t('offline.change')} variant="ghost" onPress={() => router.push('/connect')} />
      </FormScreen>
    );
  }
  return session.data.authenticated ? <Authed origin={origin} /> : <Redirect href="/login" />;
}

/**
 * A server without an account asks for one right after the key. Then the first-run questions on a
 * server that has no bots and says they were never answered; otherwise the bots. Decided once, so
 * bots made during the questions do not cut them off. A server older than the questions sends no
 * `onboarded` and goes straight to the bots.
 */
function Authed({ origin }: { origin: string }) {
  const api = useApi();
  const account = useQuery({ queryKey: ['account', origin], queryFn: api.account, retry: false });
  const [accountDone, setAccountDone] = useState(false);
  const settings = useSettings();
  const bots = useBots();
  const [onboarding, setOnboarding] = useState<boolean | null>(null);
  if (!accountDone) {
    if (account.isPending) return <Waiting />;
    if (account.data?.username === null) return <CreateAccount onDone={() => setAccountDone(true)} />;
  }
  if (onboarding === null) {
    const first =
      settings.isError || bots.isError
        ? false
        : settings.data && bots.data
          ? settings.data.onboarded === false && bots.data.length === 0
          : null;
    // Adjusting state while rendering: the choice is kept from the first answer on.
    if (first !== null) setOnboarding(first);
    return <Waiting />;
  }
  return <Redirect href={onboarding ? '/onboarding' : '/bots'} />;
}

function Waiting() {
  const c = useColors();
  return (
    <View style={[styles.center, { backgroundColor: c.background }]}>
      <ActivityIndicator color={c.mutedForeground} />
    </View>
  );
}

const styles = StyleSheet.create({ center: { flex: 1, alignItems: 'center', justifyContent: 'center' } });
