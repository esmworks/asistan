import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { openTo, StatusLine, useToggleBot, withBot } from '@/components/apps/shared';
import { toastError } from '@/components/overlay';
import { AppLogo } from '@/components/panel/AppLogo';
import { Empty, Loading, Page, PillButton, Row, Section } from '@/components/page';
import { t } from '@/i18n';
import { nav } from '@/lib/nav';
import { useBots, useConnections } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';
import { STATUS_KEY } from '@/components/apps/shared';

/** A bot's switch for every connection, with all-on and all-off. */
export default function Screen() {
  const { botId } = useLocalSearchParams<{ botId: string }>();
  const c = useColors();
  const api = useApi();
  const qc = useQueryClient();
  const { origin } = useServer();
  const { data: connections = [], isLoading } = useConnections();
  const { data: bots = [], isLoading: botsLoading } = useBots();
  const bot = bots.find((b) => b.id === botId);
  const toggle = useToggleBot();
  const [query, setQuery] = useState('');
  const q = query.trim().toLocaleLowerCase();
  const shown = q ? connections.filter((x) => x.name.toLocaleLowerCase().includes(q)) : connections;
  const all = useMutation({
    // One request per connection that changes; a connection every bot has keeps it for the others.
    mutationFn: async (on: boolean) => {
      for (const x of connections) {
        if (openTo(x, botId) === on) continue;
        await api.setConnectionBots(x.id, { allBots: false, botIds: withBot(x, bots, botId, on) });
      }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['connections', origin] }),
    onError: toastError,
  });
  const busy = toggle.isPending || all.isPending;

  if (isLoading || botsLoading) {
    return (
      <Page title={t('apps.title')}>
        <Loading />
      </Page>
    );
  }

  return (
    <Page title={t('panel.appsTitle', { name: bot?.name ?? '' })}>
      <Text style={[styles.hint, { color: c.mutedForeground }]}>{t('panel.appsHint')}</Text>
      <View style={[styles.search, { backgroundColor: c.card, borderColor: c.border }]}>
        <Feather name="search" size={16} color={c.mutedForeground} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={t('panel.appsSearch')}
          placeholderTextColor={c.mutedForeground}
          accessibilityLabel={t('panel.appsSearch')}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.searchInput, { color: c.foreground }]}
        />
      </View>
      <View style={styles.bulk}>
        <PillButton label={t('panel.appsAllOn')} disabled={busy} onPress={() => all.mutate(true)} />
        <PillButton label={t('panel.appsAllOff')} disabled={busy} onPress={() => all.mutate(false)} />
      </View>
      {shown.length === 0 ? (
        <Empty text={t('panel.appsNoMatch')} />
      ) : (
        <Section>
          {shown.map((x) => (
            <View key={x.id} style={styles.row}>
              <AppLogo id={x.catalogId} name={x.name} size={32} />
              <View style={styles.text}>
                <Text style={[styles.name, { color: c.foreground }]} numberOfLines={1}>
                  {x.name}
                </Text>
                {x.status !== 'connected' ? <StatusLine text={t(STATUS_KEY[x.status])} tone="warn" /> : null}
              </View>
              <Switch
                value={openTo(x, botId)}
                disabled={busy}
                onValueChange={(on) => toggle.mutate({ c: x, botId, on })}
                trackColor={{ true: c.primary, false: c.muted }}
                thumbColor={openTo(x, botId) ? c.primaryForeground : undefined}
                accessibilityLabel={x.name}
              />
            </View>
          ))}
        </Section>
      )}
      <Section>
        <Row icon="plus" label={t('panel.appsConnectNew')} onPress={() => nav.apps({ botId })} />
      </Section>
    </Page>
  );
}

const styles = StyleSheet.create({
  hint: { fontSize: 14, lineHeight: 20, paddingHorizontal: 4 },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    paddingHorizontal: 16,
  },
  searchInput: { flex: 1, fontSize: 16, height: 44 },
  bulk: { flexDirection: 'row', gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingHorizontal: 16 },
  text: { flex: 1, gap: 2 },
  name: { fontSize: 15, fontWeight: '500' },
});
