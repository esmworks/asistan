import type { Bot, BotSummary, Group, Room } from '@yumakbot/shared';
import Feather from '@expo/vector-icons/Feather';
import { INTL_LOCALE } from '@yumakbot/shared/i18n';
import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { PillButton } from '@/components/page';
import { locale, t } from '@/i18n';
import { nav } from '@/lib/nav';
import { isUnread, type Seen } from '@/lib/seen';
import { useServer } from '@/lib/server';
import { useStored } from '@/lib/stored';
import { useColors } from '@/lib/theme';
import { BotRow, PinnedTile, RoomRow } from './items';
import type { SidebarMenus } from './menus';
import { isMuted, MUTED_KEY, type Mutes } from './mutes';

const intl = INTL_LOCALE[locale];
const matches = (text: string, query: string) =>
  text.toLocaleLowerCase(intl).includes(query.toLocaleLowerCase(intl));

/** The sections of the bot list: needs you, pinned, groups, ungrouped and rooms. */
export function SidebarList({
  bots,
  groups,
  rooms,
  summaries,
  seen,
  query,
  menus,
}: {
  bots: Bot[];
  groups: Group[];
  rooms: Room[];
  summaries: BotSummary[];
  seen: Seen | null | undefined;
  query: string;
  menus: SidebarMenus;
}) {
  const c = useColors();
  const { origin } = useServer();
  const [mutes] = useStored<Mutes>(MUTED_KEY, {});
  const [collapsed, setCollapsed] = useStored<string[]>(`yumakbot.sidebar.collapsed:${origin}`, []);
  const q = query.trim();
  const searching = q.length > 0;

  const byBot = useMemo(() => new Map(summaries.map((s) => [s.botId, s])), [summaries]);
  const groupName = useMemo(() => new Map(groups.map((g) => [g.id, g.name])), [groups]);
  const visible = bots.filter(
    (b) => !searching || matches(b.name, q) || (!!b.groupId && matches(groupName.get(b.groupId) ?? '', q)),
  );
  // Bots waiting on the person come first, in their own section, until they are answered.
  const needsYou = visible.filter((b) => byBot.get(b.id)?.waiting);
  const waitingIds = new Set(needsYou.map((b) => b.id));
  const pinned = visible.filter((b) => b.pinned && !waitingIds.has(b.id));
  const rest = visible.filter((b) => !b.pinned && !waitingIds.has(b.id));
  const sections = [
    ...groups.map((g) => ({ group: g as Group | null, bots: rest.filter((b) => b.groupId === g.id) })),
    { group: null, bots: rest.filter((b) => !b.groupId) },
    // An empty group stays in view so it can be found; not while searching.
  ].filter((s) => s.bots.length || (s.group && !searching));
  const shownRooms = rooms.filter((r) => !searching || matches(r.title, q));

  const open = (b: Bot) => {
    const waitsIn = byBot.get(b.id)?.waiting?.threadId;
    // A card waiting in a room is answered there; otherwise in the conversation where it waits.
    if (waitsIn && rooms.some((r) => r.id === waitsIn)) return nav.room(waitsIn);
    nav.chat(b.id, waitsIn ? { threadId: waitsIn } : {});
  };
  const row = (b: Bot) => (
    <BotRow
      key={b.id}
      bot={b}
      summary={byBot.get(b.id)}
      seen={seen}
      muted={isMuted(mutes, b.id)}
      onOpen={() => open(b)}
      onMenu={() => menus.openBot(b)}
    />
  );
  const toggle = (id: string) =>
    setCollapsed(collapsed.includes(id) ? collapsed.filter((x) => x !== id) : [...collapsed, id]);

  const heading = [styles.heading, { color: c.mutedForeground }];

  return (
    <View>
      {q.length >= 2 ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => nav.search(q)}
          style={({ pressed }) => [styles.searchRow, pressed && { backgroundColor: c.accent }]}
        >
          <Feather name="search" size={16} color={c.mutedForeground} />
          <Text style={[styles.searchText, { color: c.mutedForeground }]} numberOfLines={1}>
            {t('search.inMessages', { query: q })}
          </Text>
        </Pressable>
      ) : null}

      {needsYou.length > 0 ? (
        <View style={styles.section} accessibilityLabel={t('sidebar.needsYou')}>
          <View style={styles.headingLine}>
            <Text style={heading}>{t('sidebar.needsYou').toLocaleUpperCase(intl)}</Text>
            <View style={[styles.count, { backgroundColor: c.amber }]}>
              <Text style={styles.countText}>{needsYou.length}</Text>
            </View>
          </View>
          {needsYou.map(row)}
        </View>
      ) : null}

      {pinned.length > 0 ? (
        <View style={styles.tiles}>
          {pinned.map((b) => {
            const summary = byBot.get(b.id);
            return (
              <PinnedTile
                key={b.id}
                bot={b}
                summary={summary}
                unread={!!summary && isUnread(summary, seen)}
                onOpen={() => open(b)}
                onMenu={() => menus.openBot(b)}
              />
            );
          })}
        </View>
      ) : null}

      {sections.map(({ group, bots: list }, i) => {
        const id = group?.id ?? 'ungrouped';
        // Searching shows every match, whatever was folded.
        const folded = !!group && !searching && collapsed.includes(id);
        const prevId = sections[i - 1]?.group?.id ?? null;
        const nextId = sections[i + 1]?.group?.id ?? null;
        return (
          <View key={id} style={styles.section}>
            {group ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: !folded }}
                onPress={() => toggle(id)}
                onLongPress={() => menus.openGroup(group, prevId, nextId)}
                delayLongPress={350}
                style={styles.headingLine}
              >
                <Feather
                  name={folded ? 'chevron-right' : 'chevron-down'}
                  size={14}
                  color={c.mutedForeground}
                />
                <Text style={heading} numberOfLines={1}>
                  {group.name.toLocaleUpperCase(intl)}
                </Text>
              </Pressable>
            ) : groups.length > 0 ? (
              <View style={styles.headingLine}>
                <Text style={heading}>{t('sidebar.ungrouped').toLocaleUpperCase(intl)}</Text>
              </View>
            ) : null}
            {folded ? null : list.length ? (
              list.map(row)
            ) : (
              <View style={[styles.hint, { borderColor: c.border }]}>
                <Text style={[styles.hintText, { color: c.mutedForeground }]}>{t('sidebar.emptyGroup')}</Text>
              </View>
            )}
          </View>
        );
      })}

      {bots.length > 0 && !(searching && !shownRooms.length) ? (
        <View style={styles.section} accessibilityLabel={t('rooms.title')}>
          <View style={styles.headingLine}>
            <Text style={[heading, styles.grow]}>{t('rooms.title').toLocaleUpperCase(intl)}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('rooms.new')}
              onPress={() => nav.roomEdit()}
              hitSlop={8}
              style={styles.smallButton}
            >
              <Feather name="plus" size={16} color={c.mutedForeground} />
            </Pressable>
          </View>
          {shownRooms.map((r) => (
            <RoomRow key={r.id} room={r} memberCount={r.members.length} onOpen={() => nav.room(r.id)} />
          ))}
          {!rooms.length ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => nav.roomEdit()}
              style={({ pressed }) => [styles.roomHint, pressed && { backgroundColor: c.accent }]}
            >
              <Feather name="users" size={16} color={c.mutedForeground} />
              <Text style={[styles.hintText, styles.grow, { color: c.mutedForeground, textAlign: 'left' }]}>
                {t('room.dialogHint')}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {bots.length === 0 ? (
        <View style={[styles.empty, { borderColor: c.border }]}>
          <Text style={[styles.hintText, { color: c.mutedForeground }]}>{t('sidebar.noBots')}</Text>
          <PillButton icon="plus" label={t('sidebar.createFirst')} onPress={() => nav.botEdit()} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  section: { marginTop: 4 },
  heading: { fontSize: 11, fontWeight: '600', letterSpacing: 0.8 },
  headingLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 2,
    minHeight: 30,
  },
  count: { borderRadius: 8, paddingHorizontal: 6, minWidth: 16, alignItems: 'center' },
  countText: { fontSize: 10, lineHeight: 16, fontWeight: '700', color: '#000000' },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 4, paddingVertical: 4 },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
  },
  searchText: { flex: 1, fontSize: 14 },
  hint: {
    marginHorizontal: 8,
    marginVertical: 4,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: 'dashed',
  },
  hintText: { fontSize: 13, lineHeight: 18, textAlign: 'center' },
  smallButton: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  roomHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 16,
  },
  empty: {
    alignItems: 'center',
    gap: 12,
    margin: 8,
    marginTop: 24,
    padding: 24,
    borderRadius: 16,
    borderWidth: 1,
    borderStyle: 'dashed',
  },
});
