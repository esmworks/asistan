import type { Bot, BrowserStatus, ComputerState } from '@leafbot/shared';
import Feather from '@expo/vector-icons/Feather';
import { Image } from 'expo-image';
import { useIsFocused } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { t, type MessageKey } from '@/i18n';
import { nav } from '@/lib/nav';
import { useColors } from '@/lib/theme';
import { useBrowserLive, useDesktopLive } from './live';
import { SCREEN_RATIO, SectionHead, StatusDot, useDesktopAvailable } from './parts';

export const STATUS: Record<BrowserStatus, MessageKey> = {
  off: 'computer.status.off',
  idle: 'computer.status.idle',
  bot: 'computer.status.bot',
  user: 'computer.status.user',
  window: 'computer.status.window',
};

const PHASE: Record<'asleep' | 'starting' | 'user' | 'busy' | 'idle', MessageKey> = {
  asleep: 'computer.desktop.asleep',
  starting: 'computer.desktop.starting',
  user: 'computer.desktop.user',
  busy: 'computer.desktop.busy',
  idle: 'computer.desktop.running',
};

function phaseOf(s: ComputerState): keyof typeof PHASE {
  if (s.status === 'off') return 'asleep';
  if (s.status === 'starting') return 'starting';
  if (s.user) return 'user';
  return s.busy ? 'busy' : 'idle';
}

/** The panel's card for the bot's computer when it has one, else a small live picture of its browser. */
export function ComputerCard({ bot }: { bot: Bot }) {
  return useDesktopAvailable() ? <DesktopCard bot={bot} /> : <BrowserCard bot={bot} />;
}

function BrowserCard({ bot }: { bot: Bot }) {
  const c = useColors();
  // The line to the server closes while another screen (the large view) is on top.
  const focused = useIsFocused();
  const { state, frame } = useBrowserLive(bot.id, focused);
  return (
    <View>
      <SectionHead
        title={t('computer.browserTitle')}
        right={
          <View style={styles.status}>
            <StatusDot status={state.status} />
            <Text style={[styles.statusText, { color: c.mutedForeground }]}>{t(STATUS[state.status])}</Text>
          </View>
        }
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('computer.browserOpen')}
        onPress={() => nav.computer(bot.id)}
        style={[styles.card, { backgroundColor: c.muted, borderColor: c.border }]}
      >
        <View style={styles.screen}>
          {frame ? (
            <Image
              source={{ uri: frame.uri }}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              cachePolicy="none"
            />
          ) : (
            <View style={styles.placeholder}>
              <Feather name="monitor" size={24} color={c.mutedForeground} />
              <Text style={[styles.hint, { color: c.mutedForeground }]}>
                {state.status === 'off' ? t('computer.offHint') : t('computer.waiting')}
              </Text>
            </View>
          )}
        </View>
        {state.url ? (
          <Text style={[styles.url, { color: c.mutedForeground, borderColor: c.border }]} numberOfLines={1}>
            {state.title ? `${state.title} · ` : ''}
            {state.url}
          </Text>
        ) : null}
      </Pressable>
    </View>
  );
}

function DesktopCard({ bot }: { bot: Bot }) {
  const c = useColors();
  const focused = useIsFocused();
  const { state } = useDesktopLive(bot.id, focused);
  const phase = phaseOf(state);
  return (
    <View>
      <SectionHead
        title={t('computer.desktop.title')}
        right={
          <View style={styles.status}>
            <StatusDot
              status={
                phase === 'idle' ? 'idle' : phase === 'user' ? 'user' : phase === 'busy' ? 'bot' : 'off'
              }
            />
            <Text style={[styles.statusText, { color: c.mutedForeground }]}>{t(PHASE[phase])}</Text>
          </View>
        }
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('computer.open')}
        onPress={() => nav.computer(bot.id)}
        style={[styles.card, { backgroundColor: c.muted, borderColor: c.border }]}
      >
        <View style={styles.screen}>
          <View style={styles.placeholder}>
            <Feather name={state.status === 'off' ? 'moon' : 'monitor'} size={24} color={c.mutedForeground} />
            <Text style={[styles.hint, { color: c.mutedForeground }]}>{t(PHASE[phase])}</Text>
          </View>
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  status: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  statusText: { fontSize: 13 },
  card: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  screen: { width: '100%', aspectRatio: SCREEN_RATIO },
  placeholder: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: 16,
  },
  hint: { fontSize: 13, textAlign: 'center' },
  url: { fontSize: 13, paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth },
});
