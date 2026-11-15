import type { SearchHit } from '@yumakbot/shared';
import Feather from '@expo/vector-icons/Feather';
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { t } from '@/i18n';
import { useApi } from '@/lib/server';
import { useColors } from '@/lib/theme';

/** The most matches one search brings back; enough for a long conversation. */
const FIND_LIMIT = 300;

/**
 * Finds the words in all of a conversation's messages, also those not loaded yet, and steps
 * through them from the newest. `onQuery` tells the messages on screen which words to mark.
 */
export function FindBar({
  threadId,
  seed,
  onFocus,
  onQuery,
  onClose,
}: {
  threadId: string;
  /** Opened from the search, it starts on those words and on the message that was picked. */
  seed?: { query: string; messageId?: string };
  onFocus: (messageId: string) => void;
  onQuery: (query: string) => void;
  onClose: () => void;
}) {
  const c = useColors();
  const api = useApi();
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const [query, setQuery] = useState(seed?.query ?? '');
  // Oldest first, so "next" goes down the conversation.
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [index, setIndex] = useState(-1);
  const [loading, setLoading] = useState(false);
  const q = query.trim();
  const active = q.length >= 2;
  const shown = active ? hits : [];
  const seedRef = useRef(seed);

  useEffect(() => {
    onQuery(q.length >= 2 ? q : '');
  }, [q, onQuery]);

  useEffect(() => {
    if (q.length < 2) return;
    let live = true;
    const timer = setTimeout(() => {
      setLoading(true);
      api
        .search(q, { threadId, limit: FIND_LIMIT })
        .then((found) => {
          if (!live) return;
          const ordered = [...found].reverse();
          setHits(ordered);
          const s = seedRef.current;
          const picked =
            s?.messageId && s.query === q ? ordered.findIndex((h) => h.messageId === s.messageId) : -1;
          const at = picked >= 0 ? picked : ordered.length - 1;
          setIndex(at);
          const hit = ordered[at];
          if (hit) onFocus(hit.messageId);
        })
        .catch(() => live && setHits([]))
        .finally(() => live && setLoading(false));
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q, threadId, api, onFocus]);

  const step = (by: number) => {
    if (!shown.length) return;
    const next = (index + by + shown.length) % shown.length;
    setIndex(next);
    onFocus(shown[next]!.messageId);
  };

  return (
    <View style={[styles.bar, { borderColor: c.border, backgroundColor: c.card }]}>
      <Feather name="search" size={16} color={c.mutedForeground} />
      <TextInput
        ref={input}
        value={query}
        onChangeText={setQuery}
        autoFocus={!seed?.query}
        returnKeyType="search"
        onSubmitEditing={() => step(-1)}
        placeholder={t('find.placeholder')}
        placeholderTextColor={c.mutedForeground}
        accessibilityLabel={t('find.placeholder')}
        style={[styles.input, { color: c.foreground }]}
      />
      <View style={styles.count}>
        {active && loading ? (
          <ActivityIndicator size="small" color={c.mutedForeground} />
        ) : active ? (
          <Text style={[styles.countText, { color: c.mutedForeground }]}>
            {shown.length ? t('find.position', { at: index + 1, count: shown.length }) : t('find.none')}
          </Text>
        ) : null}
      </View>
      <Step icon="chevron-up" label={t('find.previous')} disabled={!shown.length} onPress={() => step(-1)} />
      <Step icon="chevron-down" label={t('find.next')} disabled={!shown.length} onPress={() => step(1)} />
      <Step icon="x" label={t('find.close')} onPress={onClose} />
    </View>
  );
}

function Step({
  icon,
  label,
  disabled,
  onPress,
}: {
  icon: 'chevron-up' | 'chevron-down' | 'x';
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      hitSlop={4}
      style={[styles.step, disabled && { opacity: 0.3 }]}
    >
      <Feather name={icon} size={18} color={c.foreground} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginHorizontal: 12,
    marginBottom: 6,
    paddingLeft: 12,
    paddingRight: 4,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
  },
  input: { flex: 1, fontSize: 15, paddingHorizontal: 6, height: 40 },
  count: { minWidth: 24, alignItems: 'center' },
  countText: { fontSize: 12, fontVariant: ['tabular-nums'] },
  step: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
});
