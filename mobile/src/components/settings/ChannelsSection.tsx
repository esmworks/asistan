import type { Bot, WhatsAppMode, WhatsAppStatus } from '@yumakbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { useState } from 'react';
import { StyleSheet } from 'react-native';
import { FormField, TextBox } from '@/components/dialogs/common';
import { confirm, toast, toastError } from '@/components/overlay';
import { Note, PillButton, Row, Section, Segments, SwitchRow } from '@/components/page';
import { ChoiceRow, Hint, Pad, Rows } from '@/components/settings/common/controls';
import { t, type MessageKey } from '@/i18n';
import { useBots } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';

const ERRORS: Record<string, MessageKey> = {
  expired: 'whatsapp.error.expired',
  ownNumber: 'whatsapp.error.ownNumber',
  loggedOut: 'whatsapp.error.loggedOut',
  forbidden: 'whatsapp.error.forbidden',
  mismatch: 'whatsapp.error.mismatch',
  replaced: 'whatsapp.error.replaced',
  unreachable: 'whatsapp.error.unreachable',
  failing: 'whatsapp.error.failing',
};

/** The "chat apps" settings section: WhatsApp here, and where each bot's Telegram is. */
export function ChannelsSection() {
  const api = useApi();
  const { origin } = useServer();
  const { data: status } = useQuery({ queryKey: ['whatsapp', origin], queryFn: api.whatsapp });
  const { data: bots } = useBots();
  return (
    <>
      {status && bots ? (
        <WhatsAppForm key={`${status.mode}:${status.phone}:${status.botId}`} status={status} bots={bots} />
      ) : null}
      <Section title={t('channels.telegram')}>
        <Pad>
          <Hint>{t('channels.telegramHint')}</Hint>
        </Pad>
      </Section>
    </>
  );
}

function WhatsAppForm({ status, bots }: { status: WhatsAppStatus; bots: Bot[] }) {
  const api = useApi();
  const { origin } = useServer();
  const qc = useQueryClient();
  const live = bots.filter((b) => !b.archivedAt);
  const [mode, setMode] = useState<WhatsAppMode>(status.mode ?? 'separate');
  const [phone, setPhone] = useState(status.phone ?? '');
  const [botId, setBotId] = useState(status.botId ?? live.find((b) => b.isManager)?.id ?? live[0]?.id ?? '');
  const [notices, setNotices] = useState(status.notices);
  const put = (s: WhatsAppStatus) => qc.setQueryData(['whatsapp', origin], s);
  const body = () => ({ mode, phone, botId: botId || null, notices });
  const save = useMutation({
    mutationFn: () => api.setWhatsapp(body()),
    onSuccess: (s) => {
      put(s);
      toast(t('whatsapp.saved'));
    },
    onError: toastError,
  });
  const link = useMutation({
    mutationFn: async () => {
      await api.setWhatsapp(body());
      return api.linkWhatsapp();
    },
    onSuccess: put,
    onError: toastError,
  });
  const disconnect = useMutation({ mutationFn: api.disconnectWhatsapp, onSuccess: put, onError: toastError });
  const state = status.state;
  const error = status.error ? (ERRORS[status.error] ? t(ERRORS[status.error]!) : status.error) : null;

  return (
    <Section title={t('whatsapp.title')} footer={t('whatsapp.risk')}>
      <Rows>
        <Row
          label={t(`whatsapp.state.${state}`)}
          value={status.linked ? `+${status.linked}` : null}
          chevron={false}
        />
        <Pad>
          <Segments
            options={(['separate', 'own'] as const).map((m) => ({
              value: m,
              label: t(`whatsapp.mode.${m}`),
            }))}
            value={mode}
            onChange={setMode}
          />
          <Hint>{t(`whatsapp.modeHint.${mode}`)}</Hint>
          <FormField label={t(`whatsapp.phone.${mode}`)} hint={t(`whatsapp.phoneHint.${mode}`)}>
            <TextBox
              value={phone}
              onChangeText={setPhone}
              keyboardType="phone-pad"
              placeholder="905321234567"
            />
          </FormField>
        </Pad>
        <ChoiceRow
          label={t('whatsapp.bot')}
          detail={t('whatsapp.botHint')}
          value={botId}
          placeholder={t('whatsapp.botPick')}
          options={live.map((b) => ({ value: b.id, label: b.name }))}
          onChange={setBotId}
        />
        <SwitchRow
          label={t('whatsapp.notices')}
          detail={t('whatsapp.noticesHint')}
          value={notices}
          onChange={setNotices}
        />
        {state === 'linking' ? (
          <Pad>
            {status.qr ? (
              <Image source={{ uri: status.qr }} style={styles.qr} accessibilityLabel={t('whatsapp.qrAlt')} />
            ) : (
              <Hint>{t('whatsapp.qrWaiting')}</Hint>
            )}
            <Hint>{t('whatsapp.scan')}</Hint>
          </Pad>
        ) : null}
        {state === 'connected' ? (
          <Pad>
            <Hint>{t(`whatsapp.howTo.${status.mode ?? mode}`, { number: status.linked ?? '' })}</Hint>
          </Pad>
        ) : null}
        <Pad>
          {state === 'off' || state === 'error' ? (
            <PillButton
              label={t(state === 'error' ? 'whatsapp.relink' : 'whatsapp.link')}
              onPress={() => link.mutate()}
              busy={link.isPending}
              disabled={!phone.trim()}
            />
          ) : (
            <PillButton
              label={t('common.save')}
              variant="secondary"
              onPress={() => save.mutate()}
              busy={save.isPending}
            />
          )}
        </Pad>
        {state !== 'off' ? (
          <Row
            label={t('whatsapp.disconnect')}
            destructive
            chevron={false}
            busy={disconnect.isPending}
            onPress={() =>
              void confirm({
                title: t('whatsapp.disconnectConfirm'),
                destructive: true,
                confirmLabel: t('whatsapp.disconnect'),
              }).then((ok) => ok && disconnect.mutate())
            }
          />
        ) : null}
      </Rows>
      {error ? <Note tone="error">{error}</Note> : null}
    </Section>
  );
}

const styles = StyleSheet.create({
  qr: { width: 240, height: 240, alignSelf: 'center', borderRadius: 12, backgroundColor: '#fff' },
});
