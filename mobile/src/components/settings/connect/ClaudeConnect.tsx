import type { ServerInfo } from '@yumakbot/shared';
import Feather from '@expo/vector-icons/Feather';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { toastError } from '@/components/overlay';
import { useInCard } from '@/components/card';
import { PillButton } from '@/components/page';
import { Field } from '@/components/ui';
import { t } from '@/i18n';
import { useClaudeAuth, useInfo } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';

/**
 * Connects Claude: a subscription token from `claude setup-token` (run on the server's computer) or
 * an Anthropic API key. Saving tries the credential with one real request, so "connected" means
 * Claude answered. Used by the settings and the first-run screen.
 *
 * Props:
 * - `checking`: true while the caller runs a status check, so the line shows it as checking.
 * - `onConnected`: called once a saved credential has been accepted.
 *
 * `useClaudeState()` gives the same status as data: `{ loading, auth, connected, unknown, claude }`
 * (`auth` is null on a server older than the in-app sign-in).
 */

type Method = 'token' | 'apiKey';

/** The command that makes the subscription token; typed on the server's computer, not here. */
const SETUP_COMMAND = 'claude setup-token';

/** The Claude status as one line: which sign-in the server uses and whether it works. */
export function useClaudeState() {
  const { data: info } = useInfo();
  const { data: auth, isLoading } = useClaudeAuth();
  const claude = info?.claude;
  return {
    loading: isLoading || !info,
    /** Null: a server older than the in-app sign-in. */
    auth,
    connected: claude?.status === 'ok',
    /** Not checked since the server started. */
    unknown: !claude || claude.status === 'unknown',
    claude,
  };
}

export function ClaudeConnect({
  checking = false,
  onConnected,
}: {
  checking?: boolean;
  onConnected?: () => void;
}) {
  const c = useColors();
  const inCard = useInCard();
  const api = useApi();
  const { origin } = useServer();
  const qc = useQueryClient();
  const { loading, auth, connected, unknown, claude } = useClaudeState();
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<Method>('token');
  const [value, setValue] = useState('');
  const [gateway, setGateway] = useState('');
  const [result, setResult] = useState<ServerInfo['claude'] | null>(null);
  const refresh = () =>
    Promise.all(
      ['info', 'claude-auth', 'claude-models'].map((k) => qc.invalidateQueries({ queryKey: [k, origin] })),
    );
  const save = useMutation({
    mutationFn: () =>
      api.setClaudeAuth({
        kind: method,
        value: value.trim(),
        ...(method === 'apiKey' && gateway.trim() ? { baseUrl: gateway.trim() } : {}),
      }),
    onSuccess: (r) => {
      setResult(r);
      if (r.status === 'ok') {
        setValue('');
        setOpen(false);
        onConnected?.();
      }
      void refresh();
    },
    onError: (e) => setResult({ status: 'error', detail: (e as Error).message }),
  });
  const clear = useMutation({
    mutationFn: api.clearClaudeAuth,
    onSuccess: () => {
      setResult(null);
      void refresh();
    },
    onError: toastError,
  });

  if (auth === null)
    return <Text style={[styles.muted, { color: c.mutedForeground }]}>{t('claude.oldServer')}</Text>;
  if (loading) return <ActivityIndicator color={c.mutedForeground} />;

  const current =
    auth?.kind === 'token'
      ? t('claude.usingToken', { hint: auth.hint ?? '' })
      : auth?.kind === 'apiKey'
        ? auth.baseUrl
          ? t('claude.usingGateway', { hint: auth.hint ?? '', url: auth.baseUrl })
          : t('claude.usingApiKey', { hint: auth.hint ?? '' })
        : t('claude.usingLogin');
  const pending = checking || unknown;
  const showForm = open || (!connected && !pending);
  const tone = pending ? c.mutedForeground : connected ? c.success : c.amber;

  return (
    <View style={styles.root}>
      {/* On a settings card the card is the frame; on its own the status gets one. */}
      <View style={[styles.status, inCard ? styles.statusBare : { borderColor: c.border }]}>
        <View style={[styles.badge, { backgroundColor: `${tone}26` }]}>
          {checking ? (
            <ActivityIndicator size="small" color={tone} />
          ) : unknown ? (
            <View style={[styles.dot, { backgroundColor: tone }]} />
          ) : (
            <Feather name={connected ? 'check' : 'x'} size={20} color={tone} />
          )}
        </View>
        <View style={styles.statusText}>
          <Text style={[styles.title, { color: c.foreground }]}>
            {checking ? t('claude.checking') : connected || unknown ? current : t('claude.notConnected')}
          </Text>
          {!checking && (unknown || (connected && claude?.detail)) ? (
            <Text style={[styles.muted, { color: c.mutedForeground }]}>
              {unknown ? t('connection.status.unknown') : claude?.detail}
            </Text>
          ) : null}
        </View>
      </View>
      <View style={styles.actions}>
        {!checking && (connected || unknown) && !open ? (
          <PillButton variant="secondary" label={t('claude.useOther')} onPress={() => setOpen(true)} />
        ) : null}
        {auth && auth.kind !== 'login' ? (
          <PillButton
            variant="ghost"
            label={t('claude.remove')}
            onPress={() => clear.mutate()}
            busy={clear.isPending}
          />
        ) : null}
      </View>

      {showForm ? (
        <View style={styles.root}>
          <View style={styles.methods}>
            {(['token', 'apiKey'] as const).map((m) => {
              const on = method === m;
              return (
                <Pressable
                  key={m}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                  onPress={() => {
                    setMethod(m);
                    setResult(null);
                  }}
                  style={[
                    styles.method,
                    {
                      borderColor: on ? c.brand : c.border,
                      backgroundColor: on ? `${c.brand}1A` : 'transparent',
                    },
                  ]}
                >
                  <Text style={[styles.title, { color: c.foreground }]}>{t(`claude.method.${m}`)}</Text>
                  <Text style={[styles.muted, { color: c.mutedForeground }]}>
                    {t(`claude.method.${m}Hint`)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {method === 'token' ? (
            <View style={styles.root}>
              <Text style={[styles.muted, { color: c.mutedForeground }]}>{t('claude.tokenStep1')}</Text>
              <Text selectable style={[styles.command, { color: c.foreground, backgroundColor: c.muted }]}>
                {SETUP_COMMAND}
              </Text>
              <Text style={[styles.muted, { color: c.mutedForeground }]}>{t('claude.tokenStep2')}</Text>
            </View>
          ) : (
            <View style={styles.root}>
              <Text style={[styles.muted, { color: c.mutedForeground }]}>{t('claude.apiKeyBody')}</Text>
              <Field
                value={gateway}
                onChangeText={(v) => {
                  setGateway(v);
                  setResult(null);
                }}
                keyboardType="url"
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel={t('claude.gateway')}
                placeholder={t('claude.gatewayPlaceholder')}
              />
            </View>
          )}
          <Field
            value={value}
            onChangeText={(v) => {
              setValue(v);
              setResult(null);
            }}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={t(`claude.method.${method}`)}
            placeholder={t(method === 'token' ? 'claude.tokenPlaceholder' : 'claude.apiKeyPlaceholder')}
          />
          <PillButton
            variant="primary"
            label={save.isPending ? t('claude.testing') : t('claude.saveAndTest')}
            onPress={() => save.mutate()}
            busy={save.isPending}
            disabled={!value.trim()}
          />
          {result && result.status !== 'ok' ? (
            <Text style={[styles.muted, { color: c.destructive }]}>
              {result.status === 'logged-out'
                ? t('claude.invalid')
                : t('claude.failed', { detail: result.detail ?? result.reason ?? '' })}
            </Text>
          ) : null}
        </View>
      ) : null}
      {result?.status === 'ok' && !showForm ? (
        <Text style={[styles.muted, { color: c.success }]}>{t('claude.connected')}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 12 },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  statusBare: { borderWidth: 0, paddingHorizontal: 0, paddingVertical: 0 },
  badge: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { flex: 1, gap: 2 },
  title: { fontSize: 17, fontWeight: '500' },
  muted: { fontSize: 15, lineHeight: 20 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  methods: { gap: 8 },
  method: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 12, gap: 2 },
  command: {
    alignSelf: 'flex-start',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
    fontSize: 15,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
  },
});
