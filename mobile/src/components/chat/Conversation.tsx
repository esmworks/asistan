import type { SlashCommand } from '@yumakbot/app/src/lib/slash';
import type { Bot, Message, Thread } from '@yumakbot/shared';
import { useQueryClient } from '@tanstack/react-query';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Dimensions,
  FlatList,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { Avatar } from '@/components/Avatar';
import { LiveReply, MessageItem, Working } from '@/components/message/MessageItem';
import { toast, toastError } from '@/components/overlay';
import { Button } from '@/components/ui';
import { locale, t } from '@/i18n';
import { ApiError } from '@/lib/api';
import { formatters, needsDivider } from '@/lib/format';
import { nav } from '@/lib/nav';
import { useMessages } from '@/lib/queries';
import { useLiveState, useStream } from '@/lib/realtime';
import { useApi, useServer } from '@/lib/server';
import { newClientId, streamSaved, withPending } from '@/lib/stream';
import { useColors } from '@/lib/theme';
import { GoalBar, MessageBoundary, PinnedBar, QuickReplies, ToBottom } from './Bars';
import { Composer, type SendExtra } from './Composer';
import { FindBar } from './FindBar';
import { excerpt, MESSAGE_PAGE } from './text';
import type { ThreadActions } from './threads';

const fmt = formatters(locale, t);
const NONE: Message[] = [];

type Row =
  | { kind: 'divider'; key: string; label: string }
  | { kind: 'new'; key: string }
  | { kind: 'message'; key: string; m: Message }
  | { kind: 'live'; key: string }
  | { kind: 'waiting'; key: string }
  | { kind: 'replies'; key: string; options: string[] };

/** One conversation of a bot: its messages, the reply being written, and the box to write in. */
export function Conversation({
  bot,
  threadId,
  thread,
  readUntil,
  focus,
  find,
  actions,
  elsewhere,
}: {
  bot: Bot;
  threadId: string;
  thread: Thread | undefined;
  /** The time of the bot's latest reply the person had seen when the chat opened. */
  readUntil: string | null | undefined;
  /** A message to scroll to and mark. */
  focus: string | undefined;
  /** Words to look for: opens the find bar on them. */
  find: string | undefined;
  actions: ThreadActions;
  elsewhere: ReactNode;
}) {
  const c = useColors();
  const api = useApi();
  const qc = useQueryClient();
  const { origin } = useServer();
  const messagesQ = useMessages(threadId);
  const recent = messagesQ.data ?? NONE;

  // Messages before the latest page, loaded on request and kept while the conversation is open.
  const [older, setOlder] = useState<Message[]>([]);
  const [olderDone, setOlderDone] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const messages = useMemo(() => {
    if (!older.length) return recent;
    const ids = new Set(recent.map((m) => m.id));
    return [...older.filter((m) => !ids.has(m.id)), ...recent];
  }, [older, recent]);
  const hasOlder = !olderDone && (older.length > 0 || recent.length >= MESSAGE_PAGE);

  const stream = useStream(threadId);
  const liveState = useLiveState(threadId);
  const state = liveState ?? thread?.state ?? 'idle';
  const working = state === 'running' || state === 'queued';
  const [pending, setPending] = useState<Message[]>([]);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const listRef = useRef<FlatList<Row>>(null);

  const signedOut = messagesQ.error instanceof ApiError && messagesQ.error.status === 401;
  useEffect(() => {
    if (signedOut) void qc.invalidateQueries({ queryKey: ['session', origin] });
  }, [signedOut, qc, origin]);

  // --- Finding and jumping to a message ---------------------------------------------------
  const [findOpen, setFindOpen] = useState(!!find);
  const [findText, setFindText] = useState('');
  const [target, setTarget] = useState<{ id: string; n: number } | null>(focus ? { id: focus, n: 1 } : null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const focusMessage = useCallback((id: string) => setTarget((p) => ({ id, n: (p?.n ?? 0) + 1 })), []);
  const seed = useMemo(() => (find ? { query: find, messageId: focus } : undefined), [find, focus]);

  // The same screen opened again at another hit of the search.
  const [params, setParams] = useState({ find, focus });
  if (params.find !== find || params.focus !== focus) {
    setParams({ find, focus });
    if (find) setFindOpen(true);
    else if (focus) focusMessage(focus);
  }

  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  const busyOlder = useRef(false);
  const loadOlder = useCallback(async () => {
    const first = messagesRef.current[0];
    if (!first || busyOlder.current) return;
    busyOlder.current = true;
    setLoadingOlder(true);
    try {
      const page = await api.messages(threadId, first.id);
      setOlder((o) => [...page, ...o]);
      if (page.length < MESSAGE_PAGE) setOlderDone(true);
    } catch (e) {
      toastError(e);
      setTarget(null);
    } finally {
      busyOlder.current = false;
      setLoadingOlder(false);
    }
  }, [api, threadId]);

  // --- Rows, newest first for the upside-down list ----------------------------------------
  const listed = useMemo(
    () => withPending(messages, pending).filter((m) => !Array.isArray(m.props.quickReplies)),
    [messages, pending],
  );
  // Quick replies are not messages to read: the latest set shows as buttons at the end, and only
  // while nothing was said after it.
  const replies = useMemo(() => {
    const at = messages.findLastIndex((m) => Array.isArray(m.props.quickReplies));
    if (at < 0 || messages.slice(at + 1).some((m) => m.role === 'user')) return null;
    return (messages[at]!.props.quickReplies as unknown[]).filter((x): x is string => typeof x === 'string');
  }, [messages]);
  const streamDone = streamSaved(stream, messages);
  const hasText = !!stream?.text;
  const hasPending = pending.length > 0;
  const rows = useMemo(() => {
    const firstNew =
      readUntil == null
        ? null
        : (messages.find((m, i) => i > 0 && m.role === 'assistant' && m.createdAt > readUntil)?.id ?? null);
    const out: Row[] = [];
    listed.forEach((m, i) => {
      if (needsDivider(listed[i - 1], m))
        out.push({ kind: 'divider', key: `d-${m.id}`, label: fmt.dayLabel(m.createdAt) });
      if (m.id === firstNew) out.push({ kind: 'new', key: `n-${m.id}` });
      // A message keeps its row from the moment it is sent until the server's copy replaces it.
      out.push({ kind: 'message', key: m.clientId || m.id, m });
    });
    out.reverse();
    if (!streamDone && (hasText || working)) out.unshift({ kind: 'live', key: 'live' });
    // A turn held on the person's answer says so under the card that asks.
    else if (state === 'waiting') out.unshift({ kind: 'waiting', key: 'waiting' });
    else if (replies && !working && !hasPending)
      out.unshift({ kind: 'replies', key: 'replies', options: replies });
    return out;
  }, [listed, messages, readUntil, streamDone, hasText, working, state, replies, hasPending]);

  const targetIndex = useMemo(
    () => (target ? rows.findIndex((r) => r.kind === 'message' && r.m.id === target.id) : -1),
    [target, rows],
  );
  useEffect(() => {
    if (!target || messagesQ.isPending) return;
    // Further back than the pages on screen: older pages come in until it is there.
    if (targetIndex < 0) {
      if (hasOlder && !loadingOlder) void loadOlder();
      return;
    }
    // A moment for the rows that just came in to be laid out before scrolling to one.
    const id = setTimeout(() => {
      listRef.current?.scrollToIndex({ index: targetIndex, viewPosition: 0.5, animated: true });
      setHighlightId(target.id);
      setTarget(null);
    }, 50);
    return () => clearTimeout(id);
  }, [target, targetIndex, hasOlder, loadingOlder, loadOlder, messagesQ.isPending]);

  useEffect(() => {
    if (!highlightId) return;
    const id = setTimeout(() => setHighlightId(null), 2000);
    return () => clearTimeout(id);
  }, [highlightId]);

  // --- Sending ----------------------------------------------------------------------------
  const send = useCallback(
    async (text: string, extra?: SendExtra): Promise<string | null> => {
      const clientId = newClientId();
      const files = extra?.files ?? [];
      const local: Message = {
        id: `local-${clientId}`,
        threadId,
        role: 'user',
        author: 'user',
        text,
        props: {
          // Shown without links until the server's copy, with each file's final path, arrives.
          ...(files.length ? { files: files.map((f) => ({ ...f, path: '' })) } : {}),
          ...(extra?.replyTo ? { replyTo: extra.replyTo } : {}),
        },
        clientId,
        turnId: null,
        createdAt: new Date().toISOString(),
      };
      setPending((p) => [...p, local]);
      listRef.current?.scrollToOffset({ offset: 0, animated: true });
      try {
        await api.send(
          threadId,
          clientId,
          text,
          files.map((f) => f.name),
          extra?.replyTo?.id,
        );
        await qc.invalidateQueries({ queryKey: ['messages', origin, threadId] });
        return null;
      } catch (e) {
        return e instanceof ApiError ? e.message : t('chat.sendFailed');
      } finally {
        setPending((p) => p.filter((x) => x.clientId !== clientId));
      }
    },
    [api, qc, origin, threadId],
  );
  const stop = useCallback(() => void api.stop(threadId).catch(() => undefined), [api, threadId]);
  const quick = (text: string) =>
    void send(text).then((failed) => failed && toast(failed, { tone: 'error' }));

  const command = (cmd: SlashCommand) => {
    switch (cmd) {
      case 'new':
        return void actions.create();
      case 'find':
        return setFindOpen(true);
      case 'export':
        return void actions.exportConversation(threadId);
      case 'routine':
        return nav.routine({ botId: bot.id });
      case 'memory':
        return nav.settings('memory');
      case 'settings':
        return nav.botEdit(bot.id);
      case 'today':
        return nav.today();
      case 'panel':
        return nav.panel(bot.id);
      default:
    }
  };

  // --- Scrolling --------------------------------------------------------------------------
  // How many messages there were when the person scrolled up; null while at the bottom.
  const [awayAt, setAwayAt] = useState<number | null>(null);
  const away = useRef(false);
  const count = useRef(0);
  useEffect(() => {
    count.current = messages.length;
  }, [messages.length]);
  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const isAway = e.nativeEvent.contentOffset.y > 120;
    if (isAway === away.current) return;
    away.current = isAway;
    setAwayAt(isAway ? count.current : null);
  }, []);

  // Tells a screen reader about each reply once it has arrived whole; the history that loaded
  // with the conversation stays quiet.
  const [since] = useState(() => new Date().toISOString());
  const latest = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if ((m.role === 'assistant' || m.role === 'error') && m.createdAt > since) return m;
    }
    return undefined;
  }, [messages, since]);
  useEffect(() => {
    if (!latest) return;
    const who = latest.author === `bot:${bot.id}` ? bot.name : t('common.bot');
    AccessibilityInfo.announceForAccessibility(
      t(latest.role === 'error' ? 'chat.announceError' : 'chat.announceReply', {
        name: who,
        text: excerpt(latest.text, 300),
      }),
    );
  }, [latest, bot]);

  const lastId = listed[listed.length - 1]?.id;
  const retryable = state === 'idle' && !hasPending;
  const extra = useMemo(() => ({ highlightId, findText }), [highlightId, findText]);
  const renderItem = useCallback(
    ({ item }: { item: Row }) => {
      switch (item.kind) {
        case 'divider':
          return <Text style={[styles.divider, { color: c.mutedForeground }]}>{item.label}</Text>;
        case 'new':
          return <NewSince />;
        case 'live':
          return <LiveRow threadId={threadId} bot={bot} />;
        case 'waiting':
          return <Working bot={bot} activity="waiting" threadId={threadId} />;
        case 'replies':
          return <QuickReplies options={item.options} onPick={quick} />;
        case 'message':
          return (
            <MessageRow
              m={item.m}
              bot={bot}
              threadId={threadId}
              onReply={setReplyTo}
              onJump={focusMessage}
              highlighted={item.m.id === highlightId}
              find={findText}
              canRetry={retryable && item.m.id === lastId}
            />
          );
      }
    },
    // `quick` only closes over `send`, which is stable per conversation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [c, bot, threadId, highlightId, findText, send, retryable, lastId, focusMessage],
  );

  const failed = messagesQ.isError;
  return (
    <>
      {thread?.goal || thread?.pinned ? (
        <View style={styles.bars}>
          {thread.goal ? <GoalBar threadId={threadId} botId={bot.id} goal={thread.goal} /> : null}
          {thread.pinned ? (
            <PinnedBar threadId={threadId} botId={bot.id} pinned={thread.pinned} onJump={focusMessage} />
          ) : null}
        </View>
      ) : null}
      {findOpen ? (
        <FindBar
          threadId={threadId}
          seed={seed}
          onFocus={focusMessage}
          onQuery={setFindText}
          onClose={() => {
            setFindOpen(false);
            setFindText('');
          }}
        />
      ) : null}
      <View style={styles.list}>
        {messagesQ.isPending ? (
          <View style={styles.center}>
            <ActivityIndicator color={c.mutedForeground} />
          </View>
        ) : failed ? (
          <View style={styles.center}>
            <Text style={[styles.message, { color: c.foreground }]}>{t('chat.loadFailed')}</Text>
            <Text style={[styles.hint, { color: c.mutedForeground }]}>{messagesQ.error?.message}</Text>
            <Button label={t('common.retry')} onPress={() => void messagesQ.refetch()} />
          </View>
        ) : rows.length === 0 ? (
          <Pressable style={styles.empty} onPress={Keyboard.dismiss} accessible={false}>
            <Avatar name={bot.name} color={bot.color} avatar={bot.avatar} size={72} />
            <Text style={[styles.emptyName, { color: c.foreground }]}>{bot.name}</Text>
            <Text style={[styles.hint, { color: c.mutedForeground }]}>
              {bot.description || t('chat.emptyHint')}
            </Text>
          </Pressable>
        ) : (
          <FlatList
            ref={listRef}
            inverted
            data={rows}
            extraData={extra}
            keyExtractor={(r) => r.key}
            renderItem={renderItem}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.listContent}
            ItemSeparatorComponent={Gap}
            onScroll={onScroll}
            scrollEventThrottle={100}
            onEndReached={() => {
              // Scrolling up to the top brings in the page before by itself.
              if (hasOlder && !loadingOlder) void loadOlder();
            }}
            onEndReachedThreshold={0.5}
            onScrollToIndexFailed={(info) => {
              listRef.current?.scrollToOffset({
                offset: info.averageItemLength * info.index,
                animated: false,
              });
              setTimeout(
                () =>
                  listRef.current?.scrollToIndex({ index: info.index, viewPosition: 0.5, animated: true }),
                120,
              );
            }}
            ListFooterComponent={
              hasOlder ? (
                <View style={styles.older}>
                  <Pressable
                    accessibilityRole="button"
                    disabled={loadingOlder}
                    onPress={() => void loadOlder()}
                    style={[
                      styles.olderButton,
                      { backgroundColor: c.muted, opacity: loadingOlder ? 0.6 : 1 },
                    ]}
                  >
                    {loadingOlder ? <ActivityIndicator size="small" color={c.mutedForeground} /> : null}
                    <Text style={[styles.olderText, { color: c.foreground }]}>{t('chat.loadOlder')}</Text>
                  </Pressable>
                </View>
              ) : undefined
            }
          />
        )}
        {awayAt !== null ? (
          <ToBottom
            unread={messages.slice(awayAt).filter((m) => m.author !== 'user').length}
            onPress={() => listRef.current?.scrollToOffset({ offset: 0, animated: true })}
          />
        ) : null}
      </View>
      {elsewhere}
      <Composer
        draftKey={threadId}
        placeholder={t('chat.placeholder', { name: bot.name })}
        running={state === 'running' || state === 'queued' || state === 'waiting'}
        onSend={send}
        onStop={stop}
        bot={{ botId: bot.id, threadId }}
        color={bot.color}
        replyTo={replyTo}
        onReplyChange={setReplyTo}
        onCommand={command}
      />
    </>
  );
}

function Gap() {
  return <View style={styles.gap} />;
}

/** The line above the first reply that arrived since the person last looked. */
function NewSince() {
  return (
    <View style={styles.newSince} accessibilityRole="none">
      <NewLine />
      <Text style={styles.newText}>{t('chat.newSince')}</Text>
      <NewLine />
    </View>
  );
}

function NewLine() {
  return <View style={styles.newLine} />;
}

/** The reply being written; reads the live text itself so the saved rows are not drawn again. */
function LiveRow({ threadId, bot }: { threadId: string; bot: Bot }) {
  const stream = useStream(threadId);
  return <LiveReply text={stream?.text ?? ''} bot={bot} threadId={threadId} />;
}

const MessageRow = memo(function MessageRow({
  m,
  bot,
  threadId,
  onReply,
  onJump,
  highlighted,
  find,
  canRetry,
}: {
  m: Message;
  bot: Bot;
  threadId: string;
  onReply: (m: Message) => void;
  onJump: (messageId: string) => void;
  highlighted: boolean;
  find: string;
  canRetry: boolean;
}) {
  // Sent from this phone and not yet saved: shown a little faded.
  const sending = m.id.startsWith('local-');
  return (
    <MessageBoundary>
      <View style={sending ? styles.sending : undefined}>
        <MessageItem
          message={m}
          bot={bot}
          threadId={threadId}
          onReply={sending ? undefined : onReply}
          onJump={onJump}
          highlighted={highlighted}
          find={find || undefined}
          canRetry={canRetry}
        />
      </View>
    </MessageBoundary>
  );
});

const styles = StyleSheet.create({
  bars: { paddingHorizontal: 12, paddingBottom: 6, gap: 6 },
  list: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  message: { fontSize: 17, fontWeight: '600', textAlign: 'center' },
  hint: { fontSize: 14, lineHeight: 20, textAlign: 'center' },
  // Toward the top, so the keyboard coming up leaves it in view.
  empty: {
    flex: 1,
    alignItems: 'center',
    paddingTop: Dimensions.get('window').height * 0.12,
    paddingHorizontal: 24,
    gap: 12,
  },
  emptyName: { fontSize: 20, fontWeight: '600' },
  // The list is upside down, so the end is the top: a short conversation starts there.
  listContent: { paddingHorizontal: 12, paddingVertical: 12, flexGrow: 1, justifyContent: 'flex-end' },
  gap: { height: 16 },
  divider: { fontSize: 12, textAlign: 'center', paddingVertical: 8 },
  older: { alignItems: 'center', paddingBottom: 16 },
  olderButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 34,
    paddingHorizontal: 14,
    borderRadius: 17,
  },
  olderText: { fontSize: 14, fontWeight: '500' },
  newSince: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  newLine: { flex: 1, height: StyleSheet.hairlineWidth * 2, backgroundColor: 'rgba(14,165,233,0.45)' },
  newText: { fontSize: 12, fontWeight: '500', color: '#0284C7' },
  sending: { opacity: 0.7 },
});
