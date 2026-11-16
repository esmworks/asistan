import { botNoteGroups, STALE_MEMORY_DAYS, type BotNoteGroup, type Memory } from '@yumakbot/shared';
import { changeHint, changeLabel } from '@yumakbot/app/src/lib/memoryChange';
import Feather from '@expo/vector-icons/Feather';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { confirm, toast, toastError } from '@/components/overlay';
import { IconButton, PillButton, Row, Section } from '@/components/page';
import { Field } from '@/components/ui';
import { Hint, Pad, Rows } from './common/controls';
import { locale, t } from '@/i18n';
import { formatters } from '@/lib/format';
import { useBots, useMemory, useMemoryChanges, useStaleMemory } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';

const fmt = formatters(locale, t);

/** The "memory" settings section's content, under the section's own title bar. */
export function MemorySection() {
  const api = useApi();
  const { origin } = useServer();
  const { data: memory = [] } = useMemory();
  const { data: bots = [] } = useBots();
  // Notes of an archived bot stay until deleted; its name tells them apart.
  const { data: archived = [] } = useQuery({
    queryKey: ['bots', origin, 'archived'],
    queryFn: api.archivedBots,
  });
  const qc = useQueryClient();
  const c = useColors();
  const [text, setText] = useState('');
  // Each bot's notes stay folded until opened, so a long list reads as one line per bot.
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const refresh = () => qc.invalidateQueries({ queryKey: ['memory', origin] });
  const add = useMutation({
    mutationFn: () => api.addMemory({ scope: 'user', content: text }),
    onSuccess: () => {
      setText('');
      void refresh();
    },
    onError: toastError,
  });
  const clearBot = useMutation({
    mutationFn: api.removeBotMemory,
    onSuccess: refresh,
    onError: toastError,
  });
  // A deleted memory can be brought back for a moment, in case the wrong one went.
  const forget = useMutation({
    mutationFn: async (m: Memory) => {
      await api.removeMemory(m.id);
      return m;
    },
    onSuccess: (m) => {
      void refresh();
      toast(t('memory.deleted'), {
        action: {
          label: t('memory.undo'),
          onPress: () =>
            void api
              .addMemory({ scope: m.scope, botId: m.botId, content: m.content, site: m.site })
              .then(refresh)
              .catch(toastError),
        },
      });
    },
    onError: toastError,
  });
  const { data: stale = [] } = useStaleMemory();
  const clearStale = useMutation({
    mutationFn: () => api.removeStaleMemory(stale.map((m) => m.id)),
    onSuccess: refresh,
    onError: toastError,
  });
  const { data: changes = [] } = useMemoryChanges();
  // A change waits until the person says yes or no; either way it leaves the list.
  const decide = useMutation({
    mutationFn: async ({ ids, yes }: { ids: string[]; yes: boolean }) => {
      for (const id of ids) await (yes ? api.acceptMemoryChange(id) : api.rejectMemoryChange(id));
    },
    onSuccess: refresh,
    onError: toastError,
  });
  const user = memory.filter((m) => m.scope === 'user');
  const groups = botNoteGroups(memory, bots, archived);
  const botName = (id: string | null) =>
    [...bots, ...archived].find((b) => b.id === id)?.name ?? t('common.bot');
  const staleDetail = (m: Memory) =>
    `${m.scope === 'user' ? t('memory.staleShared') : botName(m.botId)} · ${
      m.lastUsedAt
        ? t('memory.lastUsed', { when: fmt.dayLabel(m.lastUsedAt) })
        : t('memory.neverUsed', { when: fmt.dayLabel(m.updatedAt) })
    }`;
  const clearAllStale = async () => {
    const ok = await confirm({
      title: t('memory.staleDeleteAllConfirm', { count: stale.length }),
      destructive: true,
      confirmLabel: t('common.delete'),
    });
    if (ok) clearStale.mutate();
  };
  const name = (g: BotNoteGroup) => g.name ?? t('common.bot');
  const clear = async (g: BotNoteGroup) => {
    const ok = await confirm({
      title: t('memory.deleteAllConfirm', { name: name(g), count: g.notes.length }),
      destructive: true,
      confirmLabel: t('common.delete'),
    });
    if (ok) clearBot.mutate(g.botId);
  };
  const label = (m: Memory) => (m.site ? `${m.site} · ${m.content}` : m.content);
  const trash = (m: Memory) => (
    <IconButton icon="trash-2" size={18} label={t('common.delete')} onPress={() => forget.mutate(m)} />
  );
  return (
    <>
      <View style={styles.form}>
        <Field
          value={text}
          onChangeText={setText}
          placeholder={t('memory.placeholder')}
          accessibilityLabel={t('memory.placeholder')}
          style={styles.grow}
          maxLength={2000}
          returnKeyType="done"
          onSubmitEditing={() => text.trim() && add.mutate()}
        />
        <PillButton
          variant="primary"
          size="large"
          label={t('common.add')}
          onPress={() => add.mutate()}
          busy={add.isPending}
          disabled={!text.trim()}
        />
      </View>
      {changes.length > 0 ? (
        <Section title={t('memory.pending')}>
          <Rows>
            <Pad>
              <Hint>{t('memory.pendingHint')}</Hint>
            </Pad>
            {changes.map((ch) => (
              <Row
                key={ch.id}
                label={changeLabel(ch)}
                detail={changeHint(ch, [...bots, ...archived], t)}
                detailLines={3}
                right={
                  <View style={styles.pair}>
                    <IconButton
                      icon="check"
                      size={18}
                      label={t('memory.accept')}
                      onPress={() => decide.mutate({ ids: [ch.id], yes: true })}
                    />
                    <IconButton
                      icon="x"
                      size={18}
                      label={t('memory.reject')}
                      onPress={() => decide.mutate({ ids: [ch.id], yes: false })}
                    />
                  </View>
                }
              />
            ))}
            {changes.length > 1 ? (
              <>
                <Row
                  label={t('memory.acceptAll')}
                  onPress={() => decide.mutate({ ids: changes.map((x) => x.id), yes: true })}
                />
                <Row
                  label={t('memory.rejectAll')}
                  destructive
                  onPress={() => decide.mutate({ ids: changes.map((x) => x.id), yes: false })}
                />
              </>
            ) : null}
          </Rows>
        </Section>
      ) : null}
      {stale.length > 0 ? (
        <Section title={t('memory.stale')}>
          <Rows>
            <Pad>
              <Hint>{t('memory.staleHint', { days: STALE_MEMORY_DAYS })}</Hint>
            </Pad>
            {stale.map((m) => (
              <Row key={m.id} label={label(m)} detail={staleDetail(m)} right={trash(m)} />
            ))}
            {stale.length > 1 ? (
              <Row label={t('memory.deleteAll')} destructive onPress={() => void clearAllStale()} />
            ) : null}
          </Rows>
        </Section>
      ) : null}
      <Section title={t('memory.user')}>
        <Rows>
          {user.length === 0 ? (
            <Pad>
              <Hint>{t('memory.empty')}</Hint>
            </Pad>
          ) : null}
          {user.map((m) => (
            <Row key={m.id} label={label(m)} right={trash(m)} />
          ))}
        </Rows>
      </Section>
      <Section title={t('memory.bots')}>
        <Rows>
          {groups.length === 0 ? (
            <Pad>
              <Hint>{t('memory.empty')}</Hint>
            </Pad>
          ) : null}
          {groups.map((g) => {
            const isOpen = open.has(g.botId);
            return (
              // The bot's line and its open notes share the card's dividers.
              <Rows key={g.botId}>
                <Row
                  label={g.archived ? t('memory.archivedBot', { name: name(g) }) : name(g)}
                  detail={t('memory.noteCount', { count: g.notes.length })}
                  onPress={() => toggle(g.botId)}
                  chevron={false}
                  right={
                    <Feather
                      name={isOpen ? 'chevron-up' : 'chevron-down'}
                      size={22}
                      color={c.mutedForeground}
                    />
                  }
                />
                {isOpen ? g.notes.map((m) => <Row key={m.id} label={label(m)} right={trash(m)} />) : null}
                {isOpen && g.notes.length > 1 ? (
                  <Row label={t('memory.deleteAll')} destructive onPress={() => void clear(g)} />
                ) : null}
              </Rows>
            );
          })}
        </Rows>
      </Section>
    </>
  );
}

const styles = StyleSheet.create({
  pair: { flexDirection: 'row', gap: 4 },
  // The box and its button share a row, as on the web.
  form: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  grow: { flex: 1 },
});
