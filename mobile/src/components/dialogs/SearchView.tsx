import type { Bot, SearchHit } from '@yumakbot/shared';
import { INTL_LOCALE } from '@yumakbot/shared/i18n';
import Feather from '@expo/vector-icons/Feather';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { Page } from '@/components/page';
import { locale, t } from '@/i18n';
import { formatters } from '@/lib/format';
import { nav } from '@/lib/nav';
import { useBots } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';

const fmt = formatters(locale, t);
const intl = INTL_LOCALE[locale];

type Result = { kind: 'bot'; bot: Bot } | { kind: 'message'; hit: SearchHit; bot: Bot | undefined };

/** Waits for typing to pause before the query reaches the server. */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** Finds bots by name and messages by their text, and opens what is picked. */
export function SearchView({ initialQuery }: { initialQuery?: string }) {
  const c = useColors();
  const api = useApi();
  const { origin } = useServer();
  const { data: bots = [] } = useBots();
  const [query, setQuery] = useState(initialQuery ?? '');
  const q = useDebounced(query.trim(), 250);
  const { data: hits = [], isFetching } = useQuery({
    queryKey: ['search', origin, q],
    queryFn: () => api.search(q),
    enabled: q.length >= 2,
    staleTime: 10_000,
  });
  const byId = useMemo(() => new Map(bots.map((b) => [b.id, b])), [bots]);
  const results: Result[] = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase(intl);
    const named = needle
      ? bots.filter((b) => b.name.toLocaleLowerCase(intl).includes(needle)).slice(0, 5)
      : [];
    return [
      ...named.map((bot) => ({ kind: 'bot' as const, bot })),
      ...(q.length >= 2 ? hits : []).map((hit) => ({
        kind: 'message' as const,
        hit,
        bot: byId.get(hit.botId),
      })),
    ];
  }, [bots, byId, hits, q, query]);

  const pick = (r: Result) => {
    if (r.kind === 'bot') nav.chat(r.bot.id);
    // The conversation opens with its find bar on the same words, at the message picked.
    else nav.chat(r.hit.botId, { threadId: r.hit.threadId, focus: r.hit.messageId, find: q });
  };

  const typed = query.trim().length > 0;
  return (
    <Page title={t('search.title')} scroll={false}>
      <View style={[styles.box, { backgroundColor: c.card, borderColor: c.border }]}>
        <Feather name="search" size={18} color={c.mutedForeground} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          placeholder={t('search.placeholder')}
          placeholderTextColor={c.mutedForeground}
          accessibilityLabel={t('search.title')}
          style={[styles.input, { color: c.foreground }]}
        />
        {isFetching ? <ActivityIndicator size="small" color={c.mutedForeground} /> : null}
      </View>
      <FlatList
        data={results}
        keyExtractor={(r) => (r.kind === 'bot' ? `b:${r.bot.id}` : `m:${r.hit.messageId}`)}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: c.mutedForeground }]}>
            {!typed
              ? t('search.hint')
              : isFetching
                ? ''
                : q.length < 2
                  ? t('search.typeMore')
                  : t('search.none')}
          </Text>
        }
        renderItem={({ item: r }) => <ResultRow r={r} q={q} onPress={() => pick(r)} />}
      />
    </Page>
  );
}

function ResultRow({ r, q, onPress }: { r: Result; q: string; onPress: () => void }) {
  const c = useColors();
  const bot = r.bot;
  const name = bot?.name ?? t('common.bot');
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.accent }]}
    >
      {bot ? (
        <Avatar name={bot.name} color={bot.color} avatar={bot.avatar} size={32} />
      ) : (
        <View style={[styles.blank, { backgroundColor: c.muted }]} />
      )}
      {r.kind === 'bot' ? (
        <View style={[styles.text, styles.center]}>
          <Text style={[styles.title, { color: c.foreground }]} numberOfLines={1}>
            {r.bot.name}
          </Text>
          {r.bot.description ? (
            <Text style={[styles.meta, { color: c.mutedForeground }]} numberOfLines={1}>
              {r.bot.description}
            </Text>
          ) : null}
        </View>
      ) : (
        <View style={styles.text}>
          <View style={styles.head}>
            <Text style={[styles.meta, styles.headName, { color: c.foreground }]} numberOfLines={1}>
              {name}
              {r.hit.threadTitle ? ` · ${r.hit.threadTitle}` : ''}
            </Text>
            <Text style={[styles.meta, { color: c.mutedForeground }]}>{fmt.shortTime(r.hit.createdAt)}</Text>
          </View>
          <Text style={[styles.excerpt, { color: c.foreground }]} numberOfLines={2}>
            <Text style={{ color: c.mutedForeground }}>
              {r.hit.role === 'user' ? t('search.you') : `${name}:`}{' '}
            </Text>
            <Highlight text={r.hit.excerpt} query={q} />
          </Text>
        </View>
      )}
    </Pressable>
  );
}

/** The excerpt with each match marked. */
function Highlight({ text, query }: { text: string; query: string }) {
  const c = useColors();
  if (!query) return <>{text}</>;
  const lower = text.toLocaleLowerCase(intl);
  const needle = query.toLocaleLowerCase(intl);
  // Lower-casing can change a text's length (some letters grow); marking would then be off.
  if (lower.length !== text.length) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (let i = lower.indexOf(needle); i >= 0; i = lower.indexOf(needle, at)) {
    parts.push(
      text.slice(at, i),
      <Text key={i} style={{ backgroundColor: c.mark }}>
        {text.slice(i, i + needle.length)}
      </Text>,
    );
    at = i + needle.length;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

const styles = StyleSheet.create({
  box: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 16,
    marginBottom: 8,
    height: 48,
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
  },
  input: { flex: 1, fontSize: 16, height: 48 },
  list: { paddingHorizontal: 8, paddingBottom: 32, flexGrow: 1 },
  empty: { fontSize: 14, textAlign: 'center', paddingHorizontal: 16, paddingVertical: 32 },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  text: { flex: 1, gap: 2 },
  center: { alignSelf: 'center' },
  title: { fontSize: 15, fontWeight: '500' },
  meta: { fontSize: 12 },
  head: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  headName: { flex: 1, fontWeight: '500' },
  excerpt: { fontSize: 14, lineHeight: 20 },
  blank: { width: 32, height: 32, borderRadius: 16 },
});
