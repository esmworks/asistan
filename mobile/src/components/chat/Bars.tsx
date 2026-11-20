import type { Bot, Thread } from '@leafbot/shared';
import Feather from '@expo/vector-icons/Feather';
import { useQueryClient } from '@tanstack/react-query';
import { Component, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { toastError } from '@/components/overlay';
import { t } from '@/i18n';
import { nav } from '@/lib/nav';
import { useRooms } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';
import { useThreadName } from './threads';

/** Refreshes what a change to a conversation's goal or pin shows in. */
function useRefreshThread(threadId: string, botId: string) {
  const qc = useQueryClient();
  const { origin } = useServer();
  return () => {
    void qc.invalidateQueries({ queryKey: ['thread', origin, threadId] });
    void qc.invalidateQueries({ queryKey: ['main-thread', origin, botId] });
    return qc.invalidateQueries({ queryKey: ['threads', origin, botId] });
  };
}

/** What the conversation is for, above its messages, with a button that clears it. */
export function GoalBar({ threadId, botId, goal }: { threadId: string; botId: string; goal: string }) {
  const c = useColors();
  const api = useApi();
  const refresh = useRefreshThread(threadId, botId);
  const clear = () =>
    void api
      .setGoal(threadId, '')
      .then(() => refresh())
      .catch(toastError);
  return (
    <View style={[styles.bar, { borderColor: c.brand, backgroundColor: c.background }]}>
      <Feather name="target" size={20} color={c.brand} style={styles.icon} />
      <Text style={[styles.barText, { color: c.foreground }]} numberOfLines={3}>
        <Text style={styles.strong}>{t('goal.label')}</Text> {goal}
      </Text>
      <Pressable accessibilityRole="button" accessibilityLabel={t('goal.clear')} onPress={clear} hitSlop={8}>
        <Feather name="x" size={20} color={c.mutedForeground} />
      </Pressable>
    </View>
  );
}

/** The message pinned above the conversation: a tap brings it into view, the cross unpins it. */
export function PinnedBar({
  threadId,
  botId,
  pinned,
  onJump,
}: {
  threadId: string;
  botId: string;
  pinned: NonNullable<Thread['pinned']>;
  onJump: (messageId: string) => void;
}) {
  const c = useColors();
  const api = useApi();
  const refresh = useRefreshThread(threadId, botId);
  const unpin = () =>
    void api
      .pinMessage(threadId, null)
      .then(() => refresh())
      .catch(toastError);
  return (
    <View style={[styles.bar, { borderColor: c.border, backgroundColor: c.background }]}>
      <Feather name="bookmark" size={20} color={c.mutedForeground} style={styles.icon} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('pin.jump')}
        onPress={() => onJump(pinned.id)}
        style={styles.grow}
      >
        <Text style={[styles.barText, { color: c.foreground }]} numberOfLines={1}>
          {pinned.text}
        </Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={t('pin.remove')} onPress={unpin} hitSlop={8}>
        <Feather name="x" size={20} color={c.mutedForeground} />
      </Pressable>
    </View>
  );
}

/**
 * Cards of this bot waiting in its other conversations (one another bot opened, a routine's),
 * which the person would not see from here otherwise.
 */
export function WaitingElsewhere({
  bot,
  threadId,
  threads,
  waiting,
  mainId,
}: {
  bot: Bot;
  threadId: string;
  threads: Thread[];
  waiting: Map<string, number>;
  mainId: string | undefined;
}) {
  const c = useColors();
  const { data: rooms = [] } = useRooms();
  const name = useThreadName(mainId);
  const others = [...waiting].filter(([id]) => id !== threadId);
  if (!others.length) return null;
  const count = others.reduce((n, [, k]) => n + k, 0);
  const [firstId] = others[0]!;
  const first = threads.find((th) => th.id === firstId);
  const text =
    others.length !== 1 || !first
      ? t('chat.waitingElsewhere', { count })
      : t('chat.waitingIn', { count, place: name(first) });
  return (
    <View style={[styles.waiting, { borderColor: c.amber, backgroundColor: c.amberSoft }]}>
      <Feather name="shield" size={20} color={c.amber} />
      <Text style={[styles.barText, { color: c.foreground }]}>{text}</Text>
      <Pressable
        accessibilityRole="button"
        onPress={() =>
          // A card waiting in a room is answered there.
          rooms.some((r) => r.id === firstId)
            ? nav.room(firstId)
            : nav.replaceChat(bot.id, firstId === mainId ? {} : { threadId: firstId })
        }
        style={[styles.show, { backgroundColor: c.muted }]}
      >
        <Text style={[styles.showText, { color: c.foreground }]}>{t('chat.showWaiting')}</Text>
      </Pressable>
    </View>
  );
}

/** The bot's suggested answers under its reply; a tap sends that text as the person's message. */
export function QuickReplies({ options, onPick }: { options: string[]; onPick: (text: string) => void }) {
  const c = useColors();
  return (
    <View style={styles.replies}>
      {options.map((o) => (
        <Pressable
          key={o}
          accessibilityRole="button"
          onPress={() => onPick(o)}
          style={({ pressed }) => [
            styles.reply,
            { borderColor: c.border, backgroundColor: pressed ? c.accent : c.background },
          ]}
        >
          <Text style={[styles.replyText, { color: c.foreground }]}>{o}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/** Back to the latest message; counts what arrived while the person read further up. */
export function ToBottom({ unread, onPress }: { unread: number; onPress: () => void }) {
  const c = useColors();
  const label = unread > 0 ? t('chat.newMessages', { count: unread }) : t('chat.toBottom');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.toBottom, { backgroundColor: c.card, borderColor: c.border }]}
    >
      <Feather name="arrow-down" size={20} color={c.foreground} />
      {unread > 0 ? <Text style={[styles.showText, { color: c.foreground }]}>{label}</Text> : null}
    </Pressable>
  );
}

/** In place of a message that could not be drawn; the rest of the conversation stays. */
export class MessageBoundary extends Component<{ children: ReactNode }, { broken: boolean }> {
  state = { broken: false };
  static getDerivedStateFromError() {
    return { broken: true };
  }
  render() {
    return this.state.broken ? <BrokenMessage /> : this.props.children;
  }
}

function BrokenMessage() {
  const c = useColors();
  return <Text style={[styles.broken, { color: c.mutedForeground }]}>{t('chat.messageBroken')}</Text>;
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  icon: { marginTop: 2 },
  grow: { flex: 1 },
  barText: { flex: 1, fontSize: 16, lineHeight: 22 },
  strong: { fontWeight: '600' },
  waiting: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderRadius: 16,
    paddingVertical: 8,
    paddingLeft: 14,
    paddingRight: 8,
  },
  show: { borderRadius: 16, paddingHorizontal: 12, height: 32, justifyContent: 'center' },
  showText: { fontSize: 16, fontWeight: '500' },
  replies: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingLeft: 4 },
  reply: { borderWidth: 1, borderRadius: 18, paddingHorizontal: 12, paddingVertical: 7, maxWidth: '100%' },
  replyText: { fontSize: 16, lineHeight: 22 },
  toBottom: {
    position: 'absolute',
    bottom: 8,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 36,
    paddingHorizontal: 12,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000000',
    shadowOpacity: 0.15,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  broken: { fontSize: 13, textAlign: 'center', paddingVertical: 4 },
});
