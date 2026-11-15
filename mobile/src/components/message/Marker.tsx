import type { Bot, Message } from '@yumakbot/shared';
import Feather from '@expo/vector-icons/Feather';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { Markdown } from '@/components/Markdown';
import { t } from '@/i18n';
import { useApprovals, useJob } from '@/lib/queries';
import { useColors } from '@/lib/theme';
import { ApprovalCard } from './Cards';
import { bubblePalette } from './util';

/** One line in the thread for a bot-to-bot exchange; opens to show it. */
export function Marker({ m, bots }: { m: Message; bots: Map<string, Bot> }) {
  const c = useColors();
  const [chosen, setChosen] = useState<boolean | null>(null);
  const props = m.props as { jobId?: string; peerBotId?: string; count?: number; replied?: boolean };
  const peer = props.peerBotId ? bots.get(props.peerBotId) : undefined;
  const { data: approvals } = useApprovals();
  // While the other bot works on it and has a card waiting somewhere, the exchange is read anyway:
  // the card may be in there.
  const peerWaits =
    !props.replied && (approvals ?? []).some((a) => a.botId === props.peerBotId && a.status === 'pending');
  const job = useJob(chosen || peerWaits ? (props.jobId ?? null) : null);
  const toThreadId = job.data?.job.toThreadId;
  const waiting = toThreadId
    ? (approvals ?? []).filter((a) => a.threadId === toThreadId && a.status === 'pending').length
    : 0;
  // Opens by itself for a waiting card, until the person closes it.
  const open = chosen ?? waiting > 0;
  const palette = bubblePalette(c);
  return (
    <View style={styles.root}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setChosen(!open)}
        style={({ pressed }) => [styles.head, pressed && { backgroundColor: c.accent }]}
      >
        <Text style={[styles.small, { color: c.mutedForeground }]}>
          {t('message.count', { count: props.count ?? 1 })}
        </Text>
        <Text style={[styles.small, { color: c.mutedForeground }]}>·</Text>
        {peer ? <Avatar name={peer.name} color={peer.color} avatar={peer.avatar} size={18} /> : null}
        <Text style={[styles.small, styles.name, { color: c.mutedForeground }]} numberOfLines={1}>
          {peer?.name ?? t('common.bot')}
        </Text>
        {waiting > 0 ? (
          <View
            style={[styles.count, { backgroundColor: c.amber }]}
            accessibilityLabel={t('chat.waitingCards', { count: waiting })}
          >
            <Text style={styles.countText}>{waiting}</Text>
          </View>
        ) : !props.replied ? (
          <View style={[styles.dot, { backgroundColor: c.success }]} />
        ) : null}
        <Feather name={open ? 'chevron-up' : 'chevron-down'} size={16} color={c.mutedForeground} />
      </Pressable>
      {open ? (
        <View style={[styles.body, { borderColor: c.border }]}>
          {job.isLoading ? (
            <Text style={[styles.small, { color: c.mutedForeground }]}>{t('common.loading')}</Text>
          ) : null}
          {job.data?.messages
            .filter((x) => x.role === 'user' || x.role === 'assistant' || x.role === 'approval')
            .map((x) => {
              if (x.role === 'approval') {
                return (
                  <ApprovalCard
                    key={x.id}
                    approvalId={String(x.props.approvalId ?? '')}
                    fallback={x.text}
                    bots={bots}
                    heldBy={typeof x.props.heldBy === 'string' ? x.props.heldBy : undefined}
                    askRule={typeof x.props.askRule === 'string' ? x.props.askRule : undefined}
                  />
                );
              }
              const who = x.role === 'assistant' ? peer : bots.get(x.author.slice(4));
              return (
                <View key={x.id} style={styles.entry}>
                  <View style={styles.who}>
                    {who ? <Avatar name={who.name} color={who.color} avatar={who.avatar} size={16} /> : null}
                    <Text style={[styles.tiny, { color: c.mutedForeground }]}>
                      {who?.name ?? t('common.bot')}
                    </Text>
                  </View>
                  <View style={styles.text}>
                    <Markdown text={x.text} palette={palette} />
                  </View>
                </View>
              );
            })}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { alignItems: 'center' },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    maxWidth: '100%',
  },
  small: { fontSize: 14, lineHeight: 20 },
  tiny: { fontSize: 12, fontWeight: '500' },
  name: { fontWeight: '500', flexShrink: 1 },
  count: {
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  countText: { fontSize: 10, fontWeight: '700', color: '#000000' },
  dot: { width: 6, height: 6, borderRadius: 3 },
  body: { alignSelf: 'stretch', marginTop: 8, gap: 12, borderRadius: 24, borderWidth: 1, padding: 16 },
  entry: { gap: 4 },
  who: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  text: { paddingLeft: 24 },
});
