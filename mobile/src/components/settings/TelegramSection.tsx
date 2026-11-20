import type { TelegramStatus } from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { useState } from 'react';
import { Linking, StyleSheet } from 'react-native';
import { FormField, TextBox } from '@/components/dialogs/common';
import { confirm, toastError } from '@/components/overlay';
import { Note, PillButton, Row, Section, SwitchRow } from '@/components/page';
import { Hint, Pad, Rows } from '@/components/settings/common/controls';
import { t } from '@/i18n';
import { useApi, useServer } from '@/lib/server';

/** A bot's own Telegram bot, in the bot's settings: the token, then pairing the person's account. */
export function TelegramSection({ botId }: { botId: string }) {
  const api = useApi();
  const { origin } = useServer();
  const qc = useQueryClient();
  const key = ['telegram', origin, botId];
  const { data: status } = useQuery({ queryKey: key, queryFn: () => api.telegram(botId) });
  const [token, setToken] = useState('');
  const put = (s: TelegramStatus) => qc.setQueryData(key, s);
  const connect = useMutation({
    mutationFn: () => api.connectTelegram(botId, token),
    onSuccess: (s) => {
      put(s);
      setToken('');
    },
    onError: toastError,
  });
  const pair = useMutation({
    mutationFn: () => api.pairTelegram(botId),
    onSuccess: put,
    onError: toastError,
  });
  const notices = useMutation({
    mutationFn: (on: boolean) => api.updateTelegram(botId, { notices: on }),
    onSuccess: put,
    onError: toastError,
  });
  const disconnect = useMutation({
    mutationFn: () => api.disconnectTelegram(botId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
    onError: toastError,
  });
  if (!status) return null;
  const open = (url: string) => void Linking.openURL(url).catch(toastError);
  const state = status.owner
    ? t('telegram.paired')
    : status.connected
      ? t('telegram.waiting')
      : t('telegram.off');

  return (
    <Section title={t('telegram.title')}>
      <Rows>
        <Row
          label={state}
          detail={status.error ? t('telegram.error', { error: status.error }) : null}
          chevron={false}
        />
        {!status.connected ? (
          <Pad>
            <Hint>
              {t('telegram.step1')} {t('telegram.botFather')}
            </Hint>
            <Hint>{t('telegram.step2')}</Hint>
            <FormField label={t('telegram.title')}>
              <TextBox
                value={token}
                onChangeText={setToken}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                placeholder={t('telegram.tokenPlaceholder')}
              />
            </FormField>
            <PillButton
              label={t('telegram.connect')}
              onPress={() => connect.mutate()}
              busy={connect.isPending}
              disabled={!token.trim()}
            />
          </Pad>
        ) : null}
        {status.connected && status.bot ? (
          <Pad>
            <Hint>
              {status.owner
                ? t('telegram.pairedWith', { bot: status.bot.username, name: status.owner.name })
                : t('telegram.connected', { bot: status.bot.username })}
            </Hint>
            {status.pairLink ? (
              <>
                {status.pairQr ? (
                  <Image
                    source={{ uri: status.pairQr }}
                    style={styles.qr}
                    accessibilityLabel={t('telegram.qrAlt')}
                  />
                ) : null}
                <Hint>{t('telegram.pairHint')}</Hint>
                <PillButton
                  label={t('telegram.openToPair')}
                  icon="send"
                  onPress={() => open(status.pairLink!)}
                />
              </>
            ) : null}
            {!status.pairLink && !status.owner ? (
              <PillButton label={t('telegram.newLink')} variant="secondary" onPress={() => pair.mutate()} />
            ) : null}
          </Pad>
        ) : null}
        {status.owner ? (
          <SwitchRow
            label={t('telegram.notices')}
            detail={t('telegram.noticesHint')}
            value={status.notices}
            onChange={(on) => notices.mutate(on)}
          />
        ) : null}
        {status.owner && status.bot ? (
          <Row
            icon="send"
            label={t('telegram.openChat')}
            onPress={() => open(`https://t.me/${status.bot!.username}`)}
          />
        ) : null}
        {status.owner && !status.pairLink ? (
          <Row label={t('telegram.otherAccount')} onPress={() => pair.mutate()} chevron={false} />
        ) : null}
        {status.connected ? (
          <Row
            label={t('telegram.disconnect')}
            destructive
            chevron={false}
            busy={disconnect.isPending}
            onPress={() =>
              void confirm({
                title: t('telegram.disconnectConfirm'),
                destructive: true,
                confirmLabel: t('telegram.disconnect'),
              }).then((ok) => ok && disconnect.mutate())
            }
          />
        ) : null}
      </Rows>
      {status.error ? <Note tone="error">{status.error}</Note> : null}
    </Section>
  );
}

const styles = StyleSheet.create({
  qr: { width: 200, height: 200, alignSelf: 'center', borderRadius: 12, backgroundColor: '#fff' },
});
