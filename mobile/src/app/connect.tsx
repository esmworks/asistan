import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert } from 'react-native';
import { Button, ErrorText, Field, FormScreen, Hint, Mark, Title } from '@/components/ui';
import { t } from '@/i18n';
import { candidates, hostOf, insecure } from '@/lib/address';
import { answers } from '@/lib/api';
import { useServer } from '@/lib/server';

/**
 * Asks the person whether to talk to a server on the internet over plain http, where anyone on the
 * way reads the access key, the password and the conversations.
 */
function acceptInsecure(origin: string): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      t('connect.insecureTitle'),
      t('connect.insecureText', { host: hostOf(origin) }),
      [
        { text: t('common.cancel'), style: 'cancel', onPress: () => resolve(false) },
        { text: t('connect.insecureConfirm'), style: 'destructive', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

/** Asks for the server's address and keeps the first form of it that an LeafBot server answers at. */
export default function Connect() {
  const { origin, setOrigin } = useServer();
  const queryClient = useQueryClient();
  const [value, setValue] = useState(origin ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    const list = candidates(value);
    if (!list.length) {
      setError(t('connect.invalid'));
      return;
    }
    setBusy(true);
    for (const next of list) {
      if (await answers(next)) {
        if (insecure(next) && !(await acceptInsecure(next))) {
          setBusy(false);
          return;
        }
        await setOrigin(next);
        await queryClient.resetQueries();
        setBusy(false);
        // Start over from the first screen, which signs in to the new server.
        if (router.canDismiss()) router.dismissAll();
        router.replace('/');
        return;
      }
    }
    setBusy(false);
    // Typed without a scheme, a server on the internet is only tried over https (see candidates).
    const typedScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim());
    setError(t(!typedScheme && list.length === 1 ? 'connect.httpsOnly' : 'connect.notLeafBot'));
  };

  return (
    <FormScreen>
      <Mark />
      <Title>{t('connect.title')}</Title>
      <Hint>{t('connect.intro')}</Hint>
      <Field
        value={value}
        onChangeText={(v) => {
          setValue(v);
          setError(null);
        }}
        placeholder={t('connect.urlPlaceholder')}
        accessibilityLabel={t('connect.url')}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus={!origin}
        keyboardType="url"
        returnKeyType="go"
        textContentType="URL"
        invalid={!!error}
        onSubmitEditing={() => void submit()}
      />
      {error ? <ErrorText>{error}</ErrorText> : null}
      <Button label={t('connect.submit')} busy={busy} onPress={() => void submit()} />
      {origin && router.canGoBack() ? (
        <Button label={t('common.cancel')} variant="ghost" onPress={() => router.back()} />
      ) : null}
    </FormScreen>
  );
}
