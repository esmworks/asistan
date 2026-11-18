import {
  botNoteGroups,
  MEMORY_REVIEW_STEPS,
  STALE_MEMORY_DAYS,
  type BotNoteGroup,
  type Memory,
} from '@yumakbot/shared';
import { changeHint, changeLabel } from '@yumakbot/app/src/lib/memoryChange';
import {
  historyText,
  historyWho,
  noteMatches,
  pinnedFirst,
  placeLabel,
  placeNoteGroups,
} from '@yumakbot/app/src/lib/memoryNotes';
import Feather from '@expo/vector-icons/Feather';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { confirm, toast, toastError } from '@/components/overlay';
import { IconButton, PillButton, Row, Section, SwitchRow } from '@/components/page';
import { Field } from '@/components/ui';
import { ChoiceRow, Hint, Lead, Pad, Rows, useSaveSettings } from './common/controls';
import { locale, t } from '@/i18n';
import { formatters } from '@/lib/format';
import {
  useBots,
  useMemory,
  useMemoryChanges,
  useRooms,
  useSession,
  useSettings,
  useStaleMemory,
} from '@/lib/queries';
import { ApiError } from '@/lib/api';
import { useApi, useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';

const fmt = formatters(locale, t);

/** The interval a looking back starts with when the person turns it on. */
const REVIEW_DEFAULT = 20;

/**
 * One note: its words, a pin, an edit and a delete. Editing turns the line into a box; the save
 * carries the version the person began on, so a note changed meanwhile is not overwritten.
 */
function NoteLine({
  m,
  detail,
  onSave,
  onPin,
  onForget,
}: {
  m: Memory;
  detail?: string;
  onSave: (m: Memory, content: string) => Promise<unknown>;
  onPin: (m: Memory) => void;
  onForget: (m: Memory) => void;
}) {
  const c = useColors();
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (draft !== null) {
    const submit = () => {
      const content = draft.trim();
      if (!content || busy) return;
      if (content === m.content) return setDraft(null);
      setBusy(true);
      onSave(m, content)
        .then(() => setDraft(null))
        // A note changed meanwhile: the list is already fetched again, so leave the stale draft.
        .catch((e) => e instanceof ApiError && e.status === 409 && setDraft(null))
        .finally(() => setBusy(false));
    };
    return (
      <Pad>
        <Field
          value={draft}
          onChangeText={setDraft}
          accessibilityLabel={t('memory.edit')}
          maxLength={2000}
          autoFocus
          returnKeyType="done"
          onSubmitEditing={submit}
        />
        <View style={styles.pair}>
          <PillButton
            variant="primary"
            label={t('common.save')}
            onPress={submit}
            busy={busy}
            disabled={!draft.trim()}
          />
          <PillButton variant="ghost" label={t('common.cancel')} onPress={() => setDraft(null)} />
        </View>
      </Pad>
    );
  }
  const text = m.site ? `${m.site} · ${m.content}` : m.content;
  return (
    <Row
      label={text}
      detail={[m.pinned ? t('memory.pinned') : null, detail].filter(Boolean).join(' · ') || undefined}
      right={
        <View style={styles.pair}>
          <IconButton
            icon="bookmark"
            size={18}
            color={m.pinned ? c.brand : undefined}
            label={m.pinned ? t('memory.unpin') : t('memory.pin')}
            onPress={() => onPin(m)}
          />
          <IconButton icon="edit-2" size={18} label={t('memory.edit')} onPress={() => setDraft(m.content)} />
          <IconButton icon="trash-2" size={18} label={t('common.delete')} onPress={() => onForget(m)} />
        </View>
      }
    />
  );
}

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
  const [query, setQuery] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const { data: rooms = [] } = useRooms();
  const { data: settings } = useSettings();
  const saveSettings = useSaveSettings();
  const session = useSession().data?.user;
  const me = session?.id;
  const managesServer = session?.role === 'owner' || session?.role === 'admin';
  // Each bot's notes stay folded until opened, so a long list reads as one line per bot.
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const refresh = () => qc.invalidateQueries({ queryKey: ['memory', origin] });
  // The server refuses a save over a note that changed meanwhile; the list is fetched again then.
  const save = useMutation({
    mutationFn: ({ m, content }: { m: Memory; content: string }) =>
      api.updateMemory(m.id, { content, updatedAt: m.updatedAt }),
    onSuccess: refresh,
    onError: (e) => {
      toastError(e);
      void refresh();
    },
  });
  const pin = useMutation({
    mutationFn: (m: Memory) => api.updateMemory(m.id, { pinned: !m.pinned }),
    onSuccess: refresh,
    onError: toastError,
  });
  const { data: history = [], isPending: historyPending } = useQuery({
    queryKey: ['memory', origin, 'history'],
    queryFn: api.memoryHistory,
    enabled: historyOpen,
  });
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
      // A place's note is written by the bots there, so it cannot be put back from here.
      const { scope } = m;
      if (scope === 'room') return;
      toast(t('memory.deleted'), {
        action: {
          label: t('memory.undo'),
          onPress: () =>
            void api
              .addMemory({ scope, botId: m.botId, content: m.content, site: m.site })
              // A pinned note comes back pinned, as it was.
              .then((back) => (m.pinned ? api.updateMemory(back.id, { pinned: true }) : back))
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
  const searching = query.trim() !== '';
  const hit = (m: Memory) => noteMatches(m, query);
  const user = pinnedFirst(memory.filter((m) => m.scope === 'user' && hit(m)));
  const groups = botNoteGroups(memory.filter(hit), bots, archived).map((g) => ({
    ...g,
    notes: pinnedFirst(g.notes),
  }));
  const roomGroups = placeNoteGroups(memory.filter(hit), t, rooms);
  const staleHits = stale.filter(hit);
  const noteProps = {
    onSave: (m: Memory, content: string) => save.mutateAsync({ m, content }),
    onPin: (m: Memory) => pin.mutate(m),
    onForget: (m: Memory) => forget.mutate(m),
  };
  const reviewEvery = settings?.memoryReviewEvery;
  const botName = (id: string | null) =>
    [...bots, ...archived].find((b) => b.id === id)?.name ?? t('common.bot');
  const staleDetail = (m: Memory) =>
    `${
      m.scope === 'user'
        ? t('memory.staleShared')
        : m.scope === 'room'
          ? placeLabel(m.place, t, rooms)
          : botName(m.botId)
    } · ${
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
      <View style={styles.search}>
        <Field
          value={query}
          onChangeText={setQuery}
          placeholder={t('memory.search')}
          accessibilityLabel={t('memory.search')}
          returnKeyType="search"
          autoCorrect={false}
        />
      </View>
      <Lead>{t('memory.pinHint')}</Lead>
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
      {staleHits.length > 0 ? (
        <Section title={t('memory.stale')}>
          <Rows>
            <Pad>
              <Hint>{t('memory.staleHint', { days: STALE_MEMORY_DAYS })}</Hint>
            </Pad>
            {staleHits.map((m) => (
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
              <Hint>{t(searching ? 'memory.searchEmpty' : 'memory.empty')}</Hint>
            </Pad>
          ) : null}
          {user.map((m) => (
            <NoteLine key={m.id} m={m} {...noteProps} />
          ))}
        </Rows>
      </Section>
      <Section title={t('memory.bots')}>
        <Rows>
          {groups.length === 0 ? (
            <Pad>
              <Hint>{t(searching ? 'memory.searchEmpty' : 'memory.empty')}</Hint>
            </Pad>
          ) : null}
          {groups.map((g) => {
            // A search opens the bots with hits, so the notes found are in sight.
            const isOpen = searching || open.has(g.botId);
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
                {isOpen ? g.notes.map((m) => <NoteLine key={m.id} m={m} {...noteProps} />) : null}
                {isOpen && !searching && g.notes.length > 1 ? (
                  <Row label={t('memory.deleteAll')} destructive onPress={() => void clear(g)} />
                ) : null}
              </Rows>
            );
          })}
        </Rows>
      </Section>
      {roomGroups.length > 0 ? (
        <Section title={t('memory.rooms')}>
          <Rows>
            {searching ? null : (
              <Pad>
                <Hint>{t('memory.roomsHint')}</Hint>
              </Pad>
            )}
            {roomGroups.map((g) => {
              const isOpen = searching || open.has(g.place);
              return (
                <Rows key={g.place}>
                  <Row
                    label={g.label}
                    detail={t('memory.noteCount', { count: g.notes.length })}
                    onPress={() => toggle(g.place)}
                    chevron={false}
                    right={
                      <Feather
                        name={isOpen ? 'chevron-up' : 'chevron-down'}
                        size={22}
                        color={c.mutedForeground}
                      />
                    }
                  />
                  {isOpen ? g.notes.map((m) => <NoteLine key={m.id} m={m} {...noteProps} />) : null}
                </Rows>
              );
            })}
          </Rows>
        </Section>
      ) : null}
      {/* The server's setting: only those who look after the server may change it. */}
      {reviewEvery !== undefined && managesServer ? (
        <Section>
          <SwitchRow
            label={t('memory.learn')}
            detail={t('memory.learnHint')}
            value={reviewEvery > 0}
            onChange={(on) => saveSettings.mutate({ memoryReviewEvery: on ? REVIEW_DEFAULT : 0 })}
          />
          {reviewEvery > 0 ? (
            <ChoiceRow
              label={t('memory.learnEvery')}
              value={String(reviewEvery)}
              options={MEMORY_REVIEW_STEPS.filter((n) => n > 0).map((n) => ({
                value: String(n),
                label: t('memory.learnEveryChoice', { count: n }),
              }))}
              onChange={(v) => saveSettings.mutate({ memoryReviewEvery: Number(v) })}
            />
          ) : null}
        </Section>
      ) : null}
      <Section title={t('memory.history')}>
        <Rows>
          <Row
            label={t('memory.history')}
            onPress={() => setHistoryOpen(!historyOpen)}
            chevron={false}
            right={
              <Feather
                name={historyOpen ? 'chevron-up' : 'chevron-down'}
                size={22}
                color={c.mutedForeground}
              />
            }
          />
          {historyOpen && !historyPending && history.length === 0 ? (
            <Pad>
              <Hint>{t('memory.historyEmpty')}</Hint>
            </Pad>
          ) : null}
          {historyOpen
            ? [...history]
                .reverse()
                .map((l) => (
                  <Row
                    key={l.id}
                    label={historyText(l, t)}
                    detail={`${historyWho(l, me, bots, t)} · ${fmt.dayLabel(l.createdAt)}`}
                  />
                ))
            : null}
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
  search: { marginTop: 8 },
});
