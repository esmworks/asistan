import type { ApnsSet, ServerInfo } from '@yumakbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as DocumentPicker from 'expo-document-picker';
import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { toast, toastError } from '@/components/overlay';
import { PillButton, Row, Section, SwitchRow } from '@/components/page';
import { Field } from '@/components/ui';
import { Chip, ChipRow, Hint, Pad, Rows, Status, useSaveSettings } from './common/controls';
import { deviceName } from './common/text';
import { AccountForm } from './connect/AccountSetup';
import { ClaudeConnect } from './connect/ClaudeConnect';
import { ModelDefaults } from './connect/ModelDefaults';
import {
  EndpointForm,
  isPiModel,
  PiModelPicker,
  ProviderKeyForm,
  useSavePiModel,
} from './connect/ProviderConnect';
import { locale, t } from '@/i18n';
import { formatters } from '@/lib/format';
import { useClaudeAuth, useInfo, useSettings } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';

const fmt = formatters(locale, t);

/** The "connection" settings section's content, under the section's own title bar. */
export function ConnectionSection() {
  const api = useApi();
  const { origin } = useServer();
  const { data: info } = useInfo();
  const { data: claudeAuth } = useClaudeAuth();
  const qc = useQueryClient();
  const check = useMutation({
    mutationFn: api.checkClaude,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['info', origin] }),
    onError: toastError,
  });
  const [leaving, setLeaving] = useState(false);
  const status = info?.claude.status ?? 'unknown';
  const claude = info?.claude;
  const hint =
    status === 'logged-out'
      ? t('connection.loggedOutHint')
      : claude?.reason === 'api-key'
        ? t('connection.apiKeyInUse', { source: claude.detail ?? '' })
        : claude?.reason === 'timeout'
          ? t('connection.timeout')
          : (claude?.detail ?? t('connection.defaultHint'));
  // As the bot list signs out: the server may not hear it, and this phone is signed out anyway.
  const logout = async () => {
    setLeaving(true);
    try {
      await api.logout();
    } catch {
      // The server's session ends on its own.
    }
    await qc.resetQueries();
    setLeaving(false);
    router.replace('/login');
  };
  return (
    <>
      <Section title={t('connection.claude')}>
        <Rows>
          {claudeAuth === null ? (
            <Row
              label={t('connection.subscription')}
              detail={hint}
              right={
                <Status
                  state={status === 'ok' ? 'ok' : status === 'unknown' ? 'unknown' : 'problem'}
                  label={t(`connection.status.${status}`)}
                />
              }
            />
          ) : (
            <Pad>
              <ClaudeConnect checking={check.isPending} />
            </Pad>
          )}
          <Row
            icon="refresh-cw"
            label={t('connection.check')}
            onPress={() => check.mutate()}
            busy={check.isPending}
            chevron={false}
          />
          <ShellSandboxRow sandbox={info?.shellSandbox} />
          <BrowserRow browser={info?.browser} />
        </Rows>
      </Section>
      <ModelCard />
      <ApiKeys />
      <Section title={t('connection.server')}>
        <Rows>
          <Row label={t('connection.address')} detail={origin} />
          <Row
            label={t('connection.connectedTo')}
            detail={origin}
            right={
              <PillButton label={t('connection.connectOther')} onPress={() => router.push('/connect')} />
            }
          />
          <Row label={t('connection.version')} detail={info?.version ?? '…'} />
          <AccountRow />
          <Row
            icon="log-out"
            label={t('connection.logoutHere')}
            right={<PillButton label={t('connection.logout')} onPress={() => void logout()} busy={leaving} />}
          />
        </Rows>
      </Section>
      <Devices />
      <ApnsCard />
    </>
  );
}

function ShellSandboxRow({ sandbox }: { sandbox: ServerInfo['shellSandbox'] | undefined }) {
  const status = sandbox?.status ?? 'unknown';
  // The bwrap error itself is useful; the other reasons say all there is.
  const reason = sandbox?.reason ? t(`sandbox.reason.${sandbox.reason}`) : null;
  const detail =
    sandbox?.reason === 'bwrap-failed' && sandbox.detail
      ? `${reason} (${sandbox.detail})`
      : (reason ?? sandbox?.detail ?? '');
  return (
    <Row
      label={t('sandbox.label')}
      detail={status === 'unavailable' ? t('sandbox.unavailableHint', { detail }) : t('sandbox.okHint')}
      right={
        <Status
          state={status === 'ok' ? 'ok' : status === 'unknown' ? 'unknown' : 'problem'}
          label={t(`sandbox.status.${status}`)}
        />
      }
    />
  );
}

function BrowserRow({ browser }: { browser: ServerInfo['browser'] | undefined }) {
  if (!browser) return null;
  const ok = browser.status === 'ok';
  return (
    <Row
      label={t('browserInfo.label')}
      detail={ok ? t('browserInfo.okHint', { path: browser.detail ?? '' }) : t('browserInfo.missingHint')}
      right={
        <Status state={ok ? 'ok' : 'problem'} label={ok ? t('browserInfo.ok') : t('browserInfo.missing')} />
      }
    />
  );
}

/** Default model and effort for Claude bots; hidden on servers that cannot store them. */
function ModelCard() {
  const c = useColors();
  const { data: settings } = useSettings();
  const save = useSaveSettings();
  if (settings?.defaultModel === undefined) return null;
  return (
    <Section title={t('model.title')}>
      <Rows>
        {settings.defaultEngine !== undefined ? <NewBotEngine /> : null}
        <Pad gap={16}>
          {settings.defaultEngine !== undefined ? (
            <View style={styles.gap2}>
              <Text style={[styles.titleBase, { color: c.foreground }]}>{t('model.claudeBots')}</Text>
              <Hint>{t('model.claudeBotsHint')}</Hint>
            </View>
          ) : null}
          <ModelDefaults
            value={{ model: settings.defaultModel, effort: settings.effort ?? '' }}
            onChange={(v) => save.mutate({ defaultModel: v.model, effort: v.effort })}
          />
        </Pad>
        {settings.backupModel !== undefined ? <BackupModel /> : null}
      </Rows>
    </Section>
  );
}

/** The model that carries the work once the usage limit is spent, instead of waiting for it. */
function BackupModel() {
  const { data: settings } = useSettings();
  const save = useSaveSettings();
  const [on, setOn] = useState<boolean | null>(null);
  const [ref, setRef] = useState<string | null>(null);
  const pi = useSavePiModel(() => setRef(null), true);
  const stored = settings?.backupModel ?? '';
  const open = on ?? !!stored;
  const value = ref ?? stored;
  return (
    <View>
      <SwitchRow
        label={t('model.backup')}
        detail={t('model.backupHint')}
        value={open}
        onChange={(v) => {
          setOn(v);
          if (!v && stored) save.mutate({ backupModel: '' });
        }}
      />
      {open ? (
        <Pad>
          <PiModelPicker value={value} onChange={setRef} />
          <TrySave
            busy={pi.save.isPending}
            disabled={!isPiModel(value) || value === stored}
            inUse={!!stored && value === stored}
            error={pi.error}
            onPress={() => pi.save.mutate(value)}
          />
        </Pad>
      ) : null}
    </View>
  );
}

/** The save button that tries the model first, with what came of it. */
function TrySave({
  busy,
  disabled,
  inUse,
  error,
  onPress,
}: {
  busy: boolean;
  disabled: boolean;
  inUse: boolean;
  error: string | null;
  onPress: () => void;
}) {
  const c = useColors();
  return (
    <View style={styles.gap2}>
      <View style={styles.tryRow}>
        <PillButton
          variant="primary"
          label={busy ? t('claude.testing') : t('provider.tryAndSave')}
          onPress={onPress}
          busy={busy}
          disabled={disabled}
        />
        {inUse ? (
          <Text style={[styles.small, { color: c.mutedForeground }]}>{t('provider.inUse')}</Text>
        ) : null}
      </View>
      {error ? (
        <Text style={[styles.small, { color: c.destructive }]}>
          {t('provider.failed', { detail: error })}
        </Text>
      ) : null}
    </View>
  );
}

/** Which AI new bots start with: Claude, or a model of a provider with a stored key. */
function NewBotEngine() {
  const c = useColors();
  const { data: settings } = useSettings();
  const save = useSaveSettings();
  const [picked, setPicked] = useState<'claude' | 'pi' | null>(null);
  const [ref, setRef] = useState<string | null>(null);
  const pi = useSavePiModel(() => setRef(null));
  const kind = picked ?? settings?.defaultEngine ?? 'claude';
  const value = ref ?? settings?.piModel ?? '';
  const saved = settings?.defaultEngine === 'pi' && settings.piModel === value;
  return (
    <Pad>
      <View style={styles.gap2}>
        <Text style={[styles.titleBase, { color: c.foreground }]}>{t('model.newBots')}</Text>
        <Hint>{t('model.newBotsHint')}</Hint>
      </View>
      <ChipRow>
        <Chip
          on={kind === 'claude'}
          label={t('ai.claude')}
          onPress={() => {
            setPicked('claude');
            if (settings?.defaultEngine !== 'claude') save.mutate({ defaultEngine: 'claude' });
          }}
        />
        <Chip on={kind === 'pi'} label={t('ai.other')} onPress={() => setPicked('pi')} />
      </ChipRow>
      {kind === 'pi' ? (
        <>
          <PiModelPicker value={value} onChange={setRef} />
          <TrySave
            busy={pi.save.isPending}
            disabled={!isPiModel(value) || saved}
            inUse={saved}
            error={pi.error}
            onPress={() => pi.save.mutate(value)}
          />
        </>
      ) : null}
    </Pad>
  );
}

/** API keys for models outside the Claude subscription. Keys are write-only from here. */
function ApiKeys() {
  const [addingEndpoint, setAddingEndpoint] = useState(false);
  return (
    <Section title={t('keys.title')} footer={t('keys.hint')}>
      <Rows>
        <Pad>
          <ProviderKeyForm />
        </Pad>
        <Pad>
          {addingEndpoint ? (
            <EndpointForm />
          ) : (
            <View style={styles.start}>
              <PillButton
                icon="server"
                label={t('provider.addCustom')}
                onPress={() => setAddingEndpoint(true)}
              />
            </View>
          )}
        </Pad>
      </Rows>
    </Section>
  );
}

/** The username and password browsers sign in with; hidden on servers older than accounts. */
function AccountRow() {
  const api = useApi();
  const { origin } = useServer();
  const { data, isError } = useQuery({ queryKey: ['account', origin], queryFn: api.account, retry: false });
  const [open, setOpen] = useState(false);
  if (isError || !data) return null;
  return (
    <View>
      <Row
        label={t('account.title')}
        detail={data.username ?? t('account.none')}
        right={
          <PillButton
            label={data.username ? t('account.change') : t('account.create')}
            onPress={() => setOpen((v) => !v)}
          />
        }
      />
      {open ? (
        <Pad>
          <AccountForm
            username={data.username ?? ''}
            change={data.username !== null}
            onDone={() => {
              setOpen(false);
              toast(t('account.saved'));
            }}
          />
        </Pad>
      ) : null}
    </View>
  );
}

/** The browsers and apps signed in to this server, each of which can be signed out from here. */
function Devices() {
  const c = useColors();
  const api = useApi();
  const { origin } = useServer();
  const qc = useQueryClient();
  const { data: sessions } = useQuery({ queryKey: ['sessions', origin], queryFn: api.sessions });
  const end = useMutation({
    mutationFn: api.endSession,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions', origin] }),
    onError: toastError,
  });
  if (!sessions?.length) return null;
  const others = sessions.filter((s) => !s.current).length;
  return (
    <Section title={t('devices.title')}>
      <Rows>
        {sessions.map((s) => {
          const { app, os } = deviceName(s.userAgent);
          const name = app && os ? t('devices.appOnOs', { app, os }) : (app ?? os ?? t('devices.unknown'));
          return (
            <Row
              key={s.id}
              label={name}
              detail={t('devices.lastSeen', { when: fmt.dayLabel(s.lastSeenAt) })}
              right={
                s.current ? (
                  <Text style={[styles.small, { color: c.mutedForeground }]}>{t('devices.this')}</Text>
                ) : (
                  <PillButton
                    variant="ghost"
                    label={t('devices.signOut')}
                    onPress={() => end.mutate(s.id)}
                    disabled={end.isPending}
                  />
                )
              }
            />
          );
        })}
        <Row
          label={t('devices.othersHint')}
          right={
            others > 1 ? (
              <PillButton
                label={t('devices.signOutOthers')}
                onPress={() => end.mutate('others')}
                disabled={end.isPending}
              />
            ) : undefined
          }
        />
      </Rows>
    </Section>
  );
}

const useApns = () => {
  const api = useApi();
  const { origin } = useServer();
  return useQuery({ queryKey: ['apns', origin], queryFn: api.apns });
};

/**
 * The Apple key that lets this server notify the iPhone app. A self-hosted server sends straight
 * to Apple, so the key belongs to whoever built and installed the app.
 */
function ApnsCard() {
  const api = useApi();
  const { origin } = useServer();
  const qc = useQueryClient();
  const { data: apns } = useApns();
  const [editing, setEditing] = useState(false);
  const done = (status: unknown) => {
    qc.setQueryData(['apns', origin], status);
    setEditing(false);
  };
  const clear = useMutation({ mutationFn: api.clearApns, onSuccess: done, onError: toastError });
  if (!apns) return null;
  return (
    <Section title={t('apns.title')}>
      <Rows>
        <Row
          label={t('apns.key')}
          detail={
            apns.configured
              ? t('apns.configured', {
                  team: apns.teamId ?? '',
                  key: apns.keyId ?? '',
                  bundle: apns.bundleId ?? '',
                })
              : t('apns.hint')
          }
        />
        {!editing ? (
          <Pad>
            <View style={styles.tryRow}>
              <PillButton
                label={apns.configured ? t('apns.change') : t('apns.add')}
                onPress={() => setEditing(true)}
              />
              {apns.configured ? (
                <PillButton
                  variant="ghost"
                  label={t('apns.remove')}
                  onPress={() => clear.mutate()}
                  busy={clear.isPending}
                />
              ) : null}
            </View>
          </Pad>
        ) : null}
        {editing ? (
          <ApnsForm
            initial={{ teamId: apns.teamId ?? '', keyId: apns.keyId ?? '', bundleId: apns.bundleId ?? '' }}
            onSaved={done}
            onCancel={() => setEditing(false)}
          />
        ) : null}
      </Rows>
    </Section>
  );
}

function ApnsForm({
  initial,
  onSaved,
  onCancel,
}: {
  initial: Omit<ApnsSet, 'key'>;
  onSaved: (status: unknown) => void;
  onCancel: () => void;
}) {
  const api = useApi();
  const [form, setForm] = useState<ApnsSet>({ ...initial, key: '' });
  const set = (k: keyof ApnsSet) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const save = useMutation({ mutationFn: () => api.setApns(form), onSuccess: onSaved, onError: toastError });
  const pickFile = async () => {
    const r = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    const uri = r.assets?.[0]?.uri;
    if (r.canceled || !uri) return;
    try {
      const text = await (await fetch(uri)).text();
      setForm((s) => ({ ...s, key: text }));
    } catch (e) {
      toastError(e);
    }
  };
  const ready = !!form.teamId.trim() && !!form.keyId.trim() && !!form.bundleId.trim() && !!form.key.trim();
  return (
    <Pad>
      <Field
        value={form.teamId}
        onChangeText={set('teamId')}
        placeholder={t('apns.teamId')}
        accessibilityLabel={t('apns.teamId')}
        autoCapitalize="characters"
        autoCorrect={false}
      />
      <Field
        value={form.keyId}
        onChangeText={set('keyId')}
        placeholder={t('apns.keyId')}
        accessibilityLabel={t('apns.keyId')}
        autoCapitalize="characters"
        autoCorrect={false}
      />
      <Field
        value={form.bundleId}
        onChangeText={set('bundleId')}
        placeholder={t('apns.bundleId')}
        accessibilityLabel={t('apns.bundleId')}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Field
        value={form.key}
        onChangeText={set('key')}
        placeholder={t('apns.keyPlaceholder')}
        accessibilityLabel={t('apns.keyFile')}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.area}
      />
      <View style={styles.tryRow}>
        <PillButton icon="file-plus" label={t('apns.pickFile')} onPress={() => void pickFile()} />
        <PillButton variant="ghost" label={t('common.cancel')} onPress={onCancel} />
        <PillButton
          variant="primary"
          label={t('common.save')}
          onPress={() => save.mutate()}
          busy={save.isPending}
          disabled={!ready}
        />
      </View>
    </Pad>
  );
}

const styles = StyleSheet.create({
  gap2: { gap: 2 },
  titleBase: { fontSize: 15, fontWeight: '500' },
  small: { fontSize: 13, lineHeight: 18 },
  tryRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  start: { alignItems: 'flex-start' },
  area: { height: undefined, minHeight: 110, borderRadius: 16, paddingTop: 12, textAlignVertical: 'top' },
});
