import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { Empty, Loading, Page, Segments } from '@/components/page';
import { Activity } from '@/components/panel/Activity';
import { Library } from '@/components/panel/Library';
import { t } from '@/i18n';
import { nav } from '@/lib/nav';
import { useBots } from '@/lib/queries';
import { useColors } from '@/lib/theme';
import { useStored } from '@/lib/stored';
import { Pressable } from 'react-native';
import Feather from '@expo/vector-icons/Feather';

type Tab = 'activity' | 'library';

/** A bot's side panel as the web app shows it on a phone: its activity and its files. */
export default function PanelScreen() {
  const { botId } = useLocalSearchParams<{ botId: string }>();
  const c = useColors();
  const bots = useBots();
  // The panel opens on the tab last viewed, whichever bot it shows.
  const [tab, setTab] = useStored<Tab>('yumakbot.panelTab', 'activity');
  const bot = bots.data?.find((b) => b.id === botId);

  if (!bot) {
    return (
      <Page title="" scroll={false}>
        {bots.isLoading ? <Loading /> : <Empty icon="alert-circle" text={t('panel.loadFailed')} />}
      </Page>
    );
  }
  return (
    <Page title={bot.name}>
      <View style={styles.hero}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('panel.editBot')}
          onPress={() => nav.botEdit(bot.id)}
        >
          <Avatar name={bot.name} color={bot.color} avatar={bot.avatar} size={72} />
          <View style={[styles.pencil, { backgroundColor: c.background, borderColor: c.border }]}>
            <Feather name="edit-2" size={14} color={c.foreground} />
          </View>
        </Pressable>
        <Text style={[styles.name, { color: c.foreground }]}>{bot.name}</Text>
        {bot.description ? (
          <Text style={[styles.description, { color: c.mutedForeground }]}>{bot.description}</Text>
        ) : null}
      </View>
      <Segments<Tab>
        value={tab === 'library' ? 'library' : 'activity'}
        onChange={setTab}
        options={[
          { value: 'activity', label: t('panel.activity') },
          { value: 'library', label: t('panel.library') },
        ]}
      />
      {tab === 'library' ? <Library bot={bot} /> : <Activity bot={bot} />}
    </Page>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', gap: 4 },
  pencil: {
    position: 'absolute',
    right: -6,
    bottom: -6,
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: { fontSize: 20, fontWeight: '600', marginTop: 8 },
  description: { fontSize: 14, lineHeight: 20, textAlign: 'center' },
});
