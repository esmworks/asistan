import {
  CATALOG_CATEGORIES,
  CONNECTION_CATALOG,
  addressKey,
  searchCatalog,
  sharesApp,
  type CatalogCategory,
  type CatalogEntry,
  type Connection,
} from '@yumakbot/shared';
import Feather from '@expo/vector-icons/Feather';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, SectionList, StyleSheet, Text, TextInput, View } from 'react-native';
import { toastError } from '@/components/overlay';
import { AppLogo } from '@/components/panel/AppLogo';
import { Empty, IconButton, Loading, Page, PillButton } from '@/components/page';
import { t, type MessageKey } from '@/i18n';
import { nav } from '@/lib/nav';
import { useConnections } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';
import { openSignIn, serviceStatus, servicesOf, StatusLine } from './shared';

type Filter = 'all' | 'connected' | CatalogCategory;

const categoryLabel = (c: CatalogCategory) => t(`apps.category.${c}` as MessageKey);

interface RowItem {
  key: string;
  logo: string | null;
  name: string;
  sub: string;
  tone?: 'ok' | 'warn';
  action: string;
  busy?: boolean;
  onPress: () => void;
}

/** The apps list: services to connect, the ones already connected, with search and filters. */
export function Browse() {
  const c = useColors();
  const api = useApi();
  const qc = useQueryClient();
  const { origin } = useServer();
  const { data: connections = [], isLoading, isError } = useConnections();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  // A catalog service already added opens its connection instead of adding it again.
  const byAddress = useMemo(() => {
    const m = new Map<string, Connection[]>();
    for (const x of connections) m.set(addressKey(x.url), [...(m.get(addressKey(x.url)) ?? []), x]);
    return m;
  }, [connections]);
  const accountsOf = (e: CatalogEntry) => byAddress.get(addressKey(e.url)) ?? [];

  // A connection of the same provider whose registered app this service can sign in with.
  const lenderOf = (e: CatalogEntry) =>
    e.auth === 'oauth' && e.client?.family
      ? connections.find(
          (x) => x.auth === 'oauth' && !!x.clientId && sharesApp(x, { url: e.url, catalogId: e.id }),
        )
      : undefined;

  const connect = useMutation({
    mutationFn: async ({ entry, lender }: { entry: CatalogEntry; lender?: Connection }) => {
      const made = await api.addConnection({
        name: entry.name,
        url: entry.url,
        auth: entry.auth,
        catalogId: entry.id,
        ...(lender ? { sameAppAs: lender.id } : {}),
      });
      if (entry.auth !== 'oauth') return { id: made.id, url: undefined };
      const started = await api.signInConnection(made.id);
      return { id: made.id, url: started.url ?? undefined };
    },
    onSuccess: ({ id, url }) => {
      void qc.invalidateQueries({ queryKey: ['connections', origin] });
      nav.apps({ connectionId: id });
      if (url) void openSignIn(url, qc, origin);
    },
    onError: toastError,
  });

  const start = (entry: CatalogEntry) => {
    const existing = accountsOf(entry)[0];
    if (existing) return nav.apps({ connectionId: existing.id });
    // A token, or an app registered with the service, is asked for first, unless another service
    // of the same provider already has the app: then only the sign-in opens.
    const lender = lenderOf(entry);
    if (entry.auth === 'token' || (entry.client && !lender)) return nav.apps({ catalogId: entry.id });
    connect.mutate({ entry, lender });
  };

  const q = query.trim();
  const services = useMemo(() => servicesOf(connections), [connections]);
  const entrySections: { title: string; entries: readonly CatalogEntry[] }[] = q
    ? [{ title: t('apps.results'), entries: searchCatalog(q, categoryLabel) }]
    : filter === 'all'
      ? [
          { title: t('apps.featured'), entries: CONNECTION_CATALOG.filter((e) => e.featured) },
          ...CATALOG_CATEGORIES.map((cat) => ({
            title: categoryLabel(cat),
            entries: CONNECTION_CATALOG.filter((e) => e.category === cat),
          })),
        ]
      : filter === 'connected'
        ? []
        : [
            {
              title: categoryLabel(filter),
              entries: CONNECTION_CATALOG.filter((e) => e.category === filter),
            },
          ];
  const shownServices =
    filter === 'connected' || (!q && filter === 'all')
      ? services
      : q
        ? services.filter((s) =>
            [s.name, ...s.accounts.map((a) => a.name)].some((n) =>
              n.toLocaleLowerCase().includes(q.toLocaleLowerCase()),
            ),
          )
        : [];

  const sections: { title: string; data: RowItem[] }[] = [];
  if (shownServices.length)
    sections.push({
      title: t('apps.yours'),
      data: shownServices.map((s) => {
        const { sub, tone } = serviceStatus(s.accounts);
        return {
          key: `own-${s.key}`,
          logo: s.logo,
          name: s.name,
          sub,
          tone,
          action: t('apps.manage'),
          onPress: () => nav.apps({ connectionId: s.accounts[0]!.id }),
        };
      }),
    });
  for (const s of entrySections) {
    if (!s.entries.length) continue;
    sections.push({
      title: s.title,
      data: s.entries.map((e) => {
        const all = accountsOf(e);
        const status = all.length ? serviceStatus(all) : null;
        return {
          key: `${s.title}-${e.id}`,
          logo: e.id,
          name: e.name,
          sub: status?.sub ?? categoryLabel(e.category),
          tone: status?.tone,
          action: status ? t('apps.manage') : t('apps.connect'),
          busy: connect.isPending && connect.variables?.entry.id === e.id,
          onPress: () => start(e),
        };
      }),
    });
  }

  const header = (
    <View style={styles.head}>
      <Text style={[styles.subtitle, { color: c.mutedForeground }]}>{t('apps.subtitle')}</Text>
      <View style={[styles.search, { backgroundColor: c.card, borderColor: c.border }]}>
        <Feather name="search" size={20} color={c.mutedForeground} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={t('apps.search')}
          placeholderTextColor={c.mutedForeground}
          accessibilityLabel={t('apps.search')}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          style={[styles.searchInput, { color: c.foreground }]}
        />
      </View>
      {!q ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.chips}
        >
          {(['all', 'connected', ...CATALOG_CATEGORIES] as Filter[]).map((f) => {
            const on = filter === f;
            return (
              <Pressable
                key={f}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => setFilter(f)}
                style={[styles.chip, { backgroundColor: on ? c.foreground : c.muted }]}
              >
                <Text style={[styles.chipText, { color: on ? c.background : c.foreground }]}>
                  {f === 'all'
                    ? t('apps.filter.all')
                    : f === 'connected'
                      ? t('apps.filter.connected')
                      : categoryLabel(f)}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
    </View>
  );

  const empty = isLoading ? (
    <Loading />
  ) : isError ? (
    <Empty icon="alert-circle" text={t('apps.loadFailed')} />
  ) : q ? (
    <Empty text={t('apps.noMatch')} />
  ) : filter === 'connected' ? (
    <Empty text={t('apps.noneConnected')} />
  ) : null;

  return (
    <Page
      title={t('apps.title')}
      right={
        <IconButton icon="plus" label={t('apps.custom')} onPress={() => nav.apps({ catalogId: 'custom' })} />
      }
      scroll={false}
    >
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.key}
        ListHeaderComponent={header}
        ListEmptyComponent={<>{empty}</>}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        stickySectionHeadersEnabled={false}
        initialNumToRender={14}
        contentContainerStyle={styles.list}
        renderSectionHeader={({ section }) => (
          <Text style={[styles.sectionTitle, { color: c.mutedForeground }]}>{section.title}</Text>
        )}
        renderItem={({ item }) => <AppRow item={item} />}
      />
    </Page>
  );
}

function AppRow({ item }: { item: RowItem }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={item.onPress}
      disabled={item.busy}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.accent }]}
    >
      <AppLogo id={item.logo} name={item.name} size={40} />
      <View style={styles.rowText}>
        <Text style={[styles.rowName, { color: c.foreground }]} numberOfLines={1}>
          {item.name}
        </Text>
        <StatusLine text={item.sub} tone={item.tone} />
      </View>
      <PillButton label={item.action} onPress={item.onPress} busy={item.busy} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: 16, paddingBottom: 40, flexGrow: 1 },
  head: { gap: 12, paddingBottom: 4 },
  subtitle: { fontSize: 16, lineHeight: 22, paddingHorizontal: 4 },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    paddingHorizontal: 16,
  },
  searchInput: { flex: 1, fontSize: 17, height: 44 },
  chips: { gap: 8, paddingVertical: 2 },
  chip: { height: 34, borderRadius: 17, paddingHorizontal: 14, justifyContent: 'center' },
  chipText: { fontSize: 16 },
  sectionTitle: { fontSize: 15, fontWeight: '500', paddingTop: 20, paddingBottom: 6, paddingHorizontal: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 60,
    paddingHorizontal: 4,
    paddingVertical: 8,
    borderRadius: 16,
  },
  rowText: { flex: 1, gap: 2 },
  rowName: { fontSize: 17, fontWeight: '500' },
});
