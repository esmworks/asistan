import {
  addressKey,
  catalogEntry,
  formHeaders,
  headerNameAllowed,
  parseMcpSetup,
  sharesApp,
  type CatalogEntry,
  type Connection,
  type ConnectionAuth,
  type ConnectionCreate,
} from '@yumakbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { toast, toastError } from '@/components/overlay';
import { AppLogo } from '@/components/panel/AppLogo';
import {
  IconButton,
  LabeledInput,
  Loading,
  Note,
  Page,
  PillButton,
  Sheet,
  SwitchRow,
  type SheetItem,
} from '@/components/page';
import { t } from '@/i18n';
import { useConnections } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';
import { NewHeaders, type HeaderDraft } from './RequestHeaders';
import { openSignIn } from './shared';

/** In the app choice of a further account: sign in through an app of its own, not another account's. */
const NEW_APP = 'new';

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function HelpLink({ href, children }: { href: string; children: string }) {
  const c = useColors();
  return (
    <Text
      accessibilityRole="link"
      onPress={() => void Linking.openURL(href)}
      style={[styles.link, { color: c.foreground }]}
    >
      {children}
    </Text>
  );
}

/** The callback address a service's registered app must name. */
function RedirectUrl() {
  const api = useApi();
  const { origin } = useServer();
  const c = useColors();
  const { data } = useQuery({
    queryKey: ['connection-redirect', origin],
    queryFn: api.connectionRedirectUrl,
  });
  if (!data) return null;
  return (
    <View style={styles.redirect}>
      <View style={styles.redirectText}>
        <Text style={[styles.label, { color: c.foreground }]}>{t('apps.redirectUrl')}</Text>
        <Text style={[styles.mono, { color: c.mutedForeground }]} selectable>
          {data.url}
        </Text>
      </View>
      <IconButton
        icon="copy"
        label={t('apps.copy')}
        onPress={() => void Clipboard.setStringAsync(data.url).then(() => toast(t('apps.copied')))}
      />
    </View>
  );
}

/**
 * Adding a service that needs something first (a token, a registered app), or any other server.
 * With `sibling`, a further account of a catalog service already connected: it asks only for a
 * name that tells the two apart, and signs in through the service's default app.
 */
export function Setup({ catalogId, siblingId }: { catalogId: string; siblingId?: string }) {
  const entry = catalogEntry(catalogId) ?? null;
  const { data: connections = [], isLoading } = useConnections();
  if (isLoading) {
    return (
      <Page title={t('apps.title')}>
        <Loading />
      </Page>
    );
  }
  if (catalogId !== 'custom' && !entry) {
    return (
      <Page title={t('apps.title')}>
        <Note>{t('apps.catalogUnknown')}</Note>
      </Page>
    );
  }
  const sibling = siblingId ? connections.find((x) => x.id === siblingId) : undefined;
  return <SetupForm entry={entry} sibling={sibling} connections={connections} />;
}

function SetupForm({
  entry,
  sibling,
  connections,
}: {
  entry: CatalogEntry | null;
  sibling?: Connection;
  connections: Connection[];
}) {
  const c = useColors();
  const api = useApi();
  const qc = useQueryClient();
  const { origin } = useServer();
  const another = !!entry && !!sibling;
  // A connection of the same provider whose registered app a first account can sign in with.
  const lender = useMemo(
    () =>
      !sibling && entry?.auth === 'oauth' && entry.client?.family
        ? connections.find(
            (x) =>
              x.auth === 'oauth' && !!x.clientId && sharesApp(x, { url: entry.url, catalogId: entry.id }),
          )
        : undefined,
    [connections, entry, sibling],
  );
  // The sibling's app serves every account: one registered with the service, or none needed.
  const reuse =
    another && entry.auth === 'oauth' && sibling.auth === 'oauth' && (!!sibling.clientId || !entry.client);
  // Another app can be picked only where accounts sign in through registered apps.
  const canChoose = reuse && !!entry.client;
  // The apps this service's accounts sign in with, one account standing for each, default first.
  const apps = useMemo(() => {
    if (!canChoose || !sibling) return [];
    const same = connections
      .filter(
        (x) =>
          x.auth === 'oauth' &&
          !!x.clientId &&
          x.catalogId === sibling.catalogId &&
          addressKey(x.url) === addressKey(sibling.url),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const byApp = new Map<string, { id: string; name: string | null; clientId: string }>();
    for (const x of same.some((y) => y.id === sibling.id) ? same : [sibling, ...same]) {
      const app = byApp.get(x.clientId!);
      if (!app) byApp.set(x.clientId!, { id: x.id, name: x.clientName, clientId: x.clientId! });
      else app.name ??= x.clientName;
    }
    return [...byApp.values()];
  }, [canChoose, connections, sibling]);
  const [picked, setPicked] = useState<string | null>(null);
  const appFrom = picked ?? apps[0]?.id ?? (reuse ? sibling.id : (lender?.id ?? NEW_APP));
  const [choosingApp, setChoosingApp] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [authSheet, setAuthSheet] = useState(false);
  const reusing = (reuse || !!lender) && appFrom !== NEW_APP;
  const [appName, setAppName] = useState('');
  const [name, setName] = useState(another ? '' : (entry?.name ?? ''));
  const [url, setUrl] = useState(entry?.url ?? '');
  const [auth, setAuth] = useState<ConnectionAuth>(entry?.auth ?? 'oauth');
  const [token, setToken] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [ownSwitch, setOwnSwitch] = useState(false);
  const [headers, setHeaders] = useState<HeaderDraft[]>([]);
  const [typed, setTyped] = useState<HeaderDraft>({ name: '', value: '' });
  // A catalog service rarely needs headers of its own: they stay behind a link until asked for.
  const [showHeaders, setShowHeaders] = useState(!entry);
  const sentHeaders = formHeaders(headers, typed);
  // A service that needs a registered app always asks for one; any other only when switched on.
  const ownApp = !reusing && (!!entry?.client || ownSwitch);
  // A new app next to the default is named, so later accounts find it in the list.
  const namingApp = canChoose && !reusing;

  const add = useMutation({
    mutationFn: async () => {
      const input: ConnectionCreate = {
        name: name.trim(),
        url: url.trim(),
        auth,
        catalogId: entry?.id ?? null,
        ...(auth === 'token' ? { token: token.trim() } : {}),
        ...(auth === 'oauth' && ownApp && clientId.trim()
          ? {
              clientId: clientId.trim(),
              ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
              ...(namingApp ? { clientName: appName.trim() } : {}),
            }
          : {}),
        ...(reusing ? { sameAppAs: appFrom } : {}),
        ...(sentHeaders.length ? { headers: sentHeaders } : {}),
      };
      const made = await api.addConnection(input);
      if (auth !== 'oauth') return { id: made.id, url: undefined };
      const started = await api.signInConnection(made.id);
      return { id: made.id, url: started.url ?? undefined };
    },
    onSuccess: ({ id, url: signIn }) => {
      void qc.invalidateQueries({ queryKey: ['connections', origin] });
      // The connection's page takes this screen's place, so back goes to the list.
      router.replace({ pathname: '/apps', params: { connectionId: id } });
      if (signIn) void openSignIn(signIn, qc, origin);
    },
    onError: toastError,
  });

  const needsClient = !!entry?.client && !entry.client.secretOptional && !reusing;
  const ready =
    !!name.trim() &&
    !!url.trim() &&
    (auth !== 'token' || !!token.trim()) &&
    (!needsClient || !!clientId.trim()) &&
    (!ownApp || !!clientId.trim()) &&
    (!namingApp || !!appName.trim()) &&
    sentHeaders.every((h) => headerNameAllowed(h.name, auth));

  const appItems: SheetItem[] = [
    ...apps.map((a, i) => ({
      label: i === 0 ? t('apps.defaultApp') : (a.name ?? a.clientId),
      selected: appFrom === a.id,
      onPress: () => setPicked(a.id),
    })),
    { label: t('apps.newApp'), selected: appFrom === NEW_APP, onPress: () => setPicked(NEW_APP) },
  ];
  const appLabel = appItems.find((i) => i.selected)?.label ?? '';

  const onUrl = (text: string) => {
    // A setup command or a JSON config pasted here fills the form, not just this field.
    const setup = text.length > 12 ? parseMcpSetup(text) : null;
    if (!setup || setup.url === text) return setUrl(text);
    setUrl(setup.url);
    if (setup.name && !name.trim()) setName(setup.name);
    if (setup.token) {
      setAuth('token');
      setToken(setup.token);
    }
  };

  return (
    <Page title={entry?.name ?? t('apps.customTitle')}>
      <View style={styles.head}>
        <AppLogo id={entry?.id ?? null} name={entry?.name ?? t('apps.customTitle')} size={44} />
        <Text style={[styles.sub, { color: c.mutedForeground }]} numberOfLines={2}>
          {entry ? hostOf(entry.url) : t('apps.customHint')}
        </Text>
      </View>

      {another ? (
        <LabeledInput
          label={t('apps.accountName')}
          hint={t('apps.accountNameHint', { name: entry.name })}
          value={name}
          onChangeText={setName}
          maxLength={80}
          autoFocus
        />
      ) : null}
      {!entry ? (
        <>
          <LabeledInput label={t('apps.name')} value={name} onChangeText={setName} maxLength={80} />
          <LabeledInput
            label={t('apps.url')}
            hint={t('apps.urlHint')}
            value={url}
            onChangeText={onUrl}
            placeholder={t('apps.urlPlaceholder')}
            keyboardType="url"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <View style={styles.field}>
            <Text style={[styles.label, { color: c.foreground }]}>{t('apps.auth')}</Text>
            <PillButton
              label={t(`apps.auth.${auth}`)}
              icon="chevron-down"
              onPress={() => setAuthSheet(true)}
            />
          </View>
          <NewHeaders headers={headers} onChange={setHeaders} typed={typed} onType={setTyped} auth={auth} />
        </>
      ) : null}
      {auth === 'token' ? (
        <View style={styles.field}>
          <LabeledInput
            label={t('apps.token')}
            hint={entry?.tokenHelp ? undefined : t('apps.tokenHint')}
            value={token}
            onChangeText={setToken}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            autoFocus={!!entry && !another}
          />
          {entry?.tokenHelp ? (
            <Text style={styles.noteText}>
              <HelpLink href={entry.tokenHelp}>{t('apps.tokenHelp', { name: entry.name })}</HelpLink>
            </Text>
          ) : null}
        </View>
      ) : null}
      {canChoose ? (
        choosingApp ? (
          <View style={styles.field}>
            <Text style={[styles.label, { color: c.foreground }]}>{t('apps.whichApp')}</Text>
            <PillButton label={appLabel} icon="chevron-down" onPress={() => setSheet(true)} />
            <Note>{t('apps.whichAppHint')}</Note>
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setChoosingApp(true);
              // With one app to choose from, the only other choice is a new one.
              if (apps.length < 2) setPicked(NEW_APP);
            }}
          >
            <Text style={[styles.link, { color: c.mutedForeground }]}>{t('apps.otherApp')}</Text>
          </Pressable>
        )
      ) : null}
      {auth === 'oauth' && !reusing ? (
        <View style={[styles.box, { borderColor: c.border }]}>
          {entry?.client ? (
            <Text style={[styles.noteText, { color: c.mutedForeground }]}>
              {t('apps.clientNeeded', { name: entry.name })}{' '}
              <HelpLink href={entry.client.help}>{t('apps.clientWhere')}</HelpLink>
            </Text>
          ) : (
            <SwitchRow
              label={t('apps.ownApp')}
              detail={t('apps.ownAppHint')}
              value={ownApp}
              onChange={setOwnSwitch}
            />
          )}
          {ownApp ? (
            <>
              {namingApp ? (
                <LabeledInput
                  label={t('apps.appName')}
                  hint={t('apps.appNameHint')}
                  value={appName}
                  onChangeText={setAppName}
                  maxLength={80}
                  placeholder={t('apps.appNamePlaceholder')}
                />
              ) : null}
              <RedirectUrl />
              <LabeledInput
                label={t('apps.clientId')}
                value={clientId}
                onChangeText={setClientId}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="off"
              />
              <LabeledInput
                label={t('apps.clientSecret')}
                hint={t('apps.clientSecretHint')}
                value={clientSecret}
                onChangeText={setClientSecret}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="off"
              />
            </>
          ) : null}
        </View>
      ) : null}
      {entry ? (
        showHeaders ? (
          <NewHeaders headers={headers} onChange={setHeaders} typed={typed} onType={setTyped} auth={auth} />
        ) : (
          <Pressable accessibilityRole="button" onPress={() => setShowHeaders(true)}>
            <Text style={[styles.link, { color: c.mutedForeground }]}>{t('apps.headerAdd')}</Text>
          </Pressable>
        )
      ) : null}
      {another && auth === 'oauth' ? (
        <View style={[styles.callout, { backgroundColor: c.muted }]}>
          <Text style={[styles.noteText, { color: c.foreground }]}>
            {t('apps.accountSignInNote', { name: entry.name })}
          </Text>
        </View>
      ) : null}
      <Note>{t('apps.trustNote')}</Note>
      <View style={styles.actions}>
        <PillButton label={t('common.cancel')} variant="ghost" onPress={() => router.back()} />
        <PillButton
          label={auth === 'oauth' ? t('apps.connectSignIn') : t('apps.connect')}
          icon={auth === 'oauth' ? 'log-in' : 'link'}
          variant="primary"
          busy={add.isPending}
          disabled={!ready}
          onPress={() => add.mutate()}
        />
      </View>
      <Sheet
        open={authSheet}
        onClose={() => setAuthSheet(false)}
        title={t('apps.auth')}
        items={(['oauth', 'token', 'none'] as const).map((a) => ({
          label: t(`apps.auth.${a}`),
          selected: auth === a,
          onPress: () => setAuth(a),
        }))}
      />
      <Sheet open={sheet} onClose={() => setSheet(false)} title={t('apps.whichApp')} items={appItems} />
    </Page>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  sub: { flex: 1, fontSize: 16 },
  field: { gap: 6 },
  label: { fontSize: 16, fontWeight: '500', paddingHorizontal: 4 },
  link: { fontSize: 16, textDecorationLine: 'underline' },
  noteText: { fontSize: 16, lineHeight: 22 },
  box: { borderWidth: 1, borderRadius: 16, padding: 16, gap: 16 },
  callout: { borderRadius: 16, paddingHorizontal: 16, paddingVertical: 12 },
  redirect: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  redirectText: { flex: 1, gap: 2 },
  mono: { fontSize: 13, fontFamily: 'Courier' },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
});
