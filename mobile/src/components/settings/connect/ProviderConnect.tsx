import type { ProviderInfo } from '@yumakbot/shared';
import Feather from '@expo/vector-icons/Feather';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';
import { IconButton, PillButton } from '@/components/page';
import { toast, toastError } from '@/components/overlay';
import { Chip, ChipRow, ChoiceRow } from '@/components/settings/common/controls';
import { Field } from '@/components/ui';
import { t } from '@/i18n';
import { useProviderModels, useProviders } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';

/**
 * Keys and endpoints for models outside the Claude subscription. The server keeps every key; the
 * app only ever sees its last characters.
 *
 * - `ProviderKeyForm` (no props): lists the saved providers and adds a key or a custom endpoint.
 * - `EndpointRow` (`provider`): one of the person's own endpoints, with edit, refresh and remove.
 * - `EndpointForm` (no props): adds an OpenAI-compatible endpoint (Ollama, LM Studio, a hosted one).
 * - `PiModelPicker` (`value`, `onChange`): picks `provider/model` among providers with a key.
 * - `useSavePiModel(onSaved?, backup?)`: tries a `provider/model` with one request, then stores it
 *   as what new bots start with (or the backup model when `backup`); returns `{ save, error }`.
 * - `isPiModel(ref)`, `providerName(id)`: helpers.
 */

/** Offered first; every other provider the server knows is under "Other". */
const POPULAR = ['openai', 'google', 'openrouter', 'deepseek', 'xai', 'mistral', 'groq'];
/** Product names, not words to translate; other providers show their id. */
const NAMES: Record<string, string> = {
  openai: 'OpenAI',
  google: 'Google Gemini',
  openrouter: 'OpenRouter',
  deepseek: 'DeepSeek',
  xai: 'xAI',
  mistral: 'Mistral',
  groq: 'Groq',
};
export const providerName = (id: string) => NAMES[id] ?? id;
/** The chip that opens the form for the person's own endpoint; never a provider id. */
const CUSTOM = '+custom';
/** Ollama's address on the same computer; an address, not a word to translate. */
const EXAMPLE_URL = 'http://localhost:11434/v1';
const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });

/** Splits `provider/model`; a text without a slash is all model. */
function splitPiModel(ref: string): { provider: string; model: string } {
  const i = ref.indexOf('/');
  return i > 0 ? { provider: ref.slice(0, i), model: ref.slice(i + 1) } : { provider: '', model: ref };
}

/** True when `provider/model` names both parts. */
export function isPiModel(ref: string) {
  const { provider, model } = splitPiModel(ref);
  return !!provider && !!model;
}

function useRefreshProviders() {
  const qc = useQueryClient();
  const { origin } = useServer();
  return () => qc.invalidateQueries({ queryKey: ['providers', origin] });
}

/** A bordered line with a round icon, as the saved providers and endpoints are listed. */
function SavedLine({
  icon,
  title,
  sub,
  children,
}: {
  icon: 'check' | 'server';
  title: string;
  sub?: string;
  children?: ReactNode;
}) {
  const c = useColors();
  return (
    <View style={[styles.saved, { borderColor: c.border }]}>
      <View style={[styles.badge, { backgroundColor: `${c.success}26` }]}>
        <Feather name={icon} size={16} color={c.success} />
      </View>
      <View style={styles.savedText}>
        <Text style={[styles.title, { color: c.foreground }]} numberOfLines={2}>
          {title}
        </Text>
        {sub ? (
          <Text style={[styles.sub, { color: c.mutedForeground, fontFamily: MONO }]} numberOfLines={1}>
            {sub}
          </Text>
        ) : null}
      </View>
      {children}
    </View>
  );
}

export function ProviderKeyForm() {
  const c = useColors();
  const api = useApi();
  const { data: providers = [], isLoading } = useProviders();
  const [provider, setProvider] = useState('');
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const refresh = useRefreshProviders();
  const ids = providers.filter((p) => !p.custom).map((p) => p.id);
  const popular = POPULAR.filter((id) => ids.includes(id));
  const others = ids.filter((id) => !popular.includes(id));
  const current = provider || popular[0] || ids[0] || '';
  const save = useMutation({
    mutationFn: () => api.setProviderKey(current, key.trim()),
    onSuccess: () => {
      setKey('');
      setError(null);
      void refresh();
    },
    onError: (e) => setError((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: api.removeProviderKey,
    onSuccess: () => void refresh(),
    onError: toastError,
  });

  if (isLoading) return <ActivityIndicator color={c.mutedForeground} />;
  const configured = providers.filter((p) => p.configured);
  const pick = (id: string) => {
    setProvider(id);
    setError(null);
  };

  return (
    <View style={styles.root}>
      {configured.map((p) =>
        p.custom ? (
          <EndpointRow key={p.id} provider={p} />
        ) : (
          <SavedLine
            key={p.id}
            icon="check"
            title={t('provider.saved', { provider: providerName(p.id), hint: p.hint ?? '' })}
          >
            <IconButton
              icon="x"
              size={18}
              label={t('common.remove')}
              onPress={() => remove.mutate(p.id)}
              disabled={remove.isPending}
            />
          </SavedLine>
        ),
      )}
      <Text style={[styles.title, { color: c.foreground }]}>
        {configured.length ? t('provider.addAnother') : t('provider.pick')}
      </Text>
      <ChipRow>
        {popular.map((id) => (
          <Chip key={id} on={current === id} onPress={() => pick(id)} label={providerName(id)} />
        ))}
        <Chip
          on={current === CUSTOM}
          onPress={() => pick(CUSTOM)}
          icon="server"
          label={t('provider.custom')}
        />
      </ChipRow>
      {others.length > 0 ? (
        <View style={[styles.other, { borderColor: c.border }]}>
          <ChoiceRow
            label={t('provider.other')}
            value={others.includes(current) ? current : ''}
            options={others.map((id) => ({ value: id, label: id }))}
            onChange={pick}
          />
        </View>
      ) : null}
      {current === CUSTOM ? (
        <EndpointForm />
      ) : (
        <>
          <Field
            value={key}
            onChangeText={(v) => {
              setKey(v);
              setError(null);
            }}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={t('provider.keyFor', { provider: providerName(current) })}
            placeholder={t('provider.keyFor', { provider: providerName(current) })}
          />
          <PillButton
            variant="primary"
            label={t('common.save')}
            onPress={() => key.trim() && save.mutate()}
            busy={save.isPending}
            disabled={!key.trim()}
          />
          {error ? <Text style={[styles.sub, { color: c.destructive }]}>{error}</Text> : null}
        </>
      )}
    </View>
  );
}

/** One of the person's own endpoints: its name, where it is, and its model list on request. */
export function EndpointRow({ provider: p }: { provider: ProviderInfo }) {
  const api = useApi();
  const qc = useQueryClient();
  const { origin } = useServer();
  const refresh = useMutation({
    mutationFn: () => api.refreshEndpoint(p.id),
    onSuccess: (models) => {
      qc.setQueryData(['provider-models', origin, p.id], models);
      toast(t('provider.customRefreshed', { count: models.length }));
    },
    onError: toastError,
  });
  const remove = useMutation({
    mutationFn: () => api.removeEndpoint(p.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['providers', origin] }),
    onError: toastError,
  });
  const [editing, setEditing] = useState(false);
  if (editing) return <EndpointEdit provider={p} onDone={() => setEditing(false)} />;
  return (
    <SavedLine
      icon="server"
      title={p.custom!.name}
      sub={`${p.custom!.baseUrl}${p.hint ? ` · ${p.hint}` : ''}`}
    >
      <IconButton icon="edit-2" size={17} label={t('provider.customEdit')} onPress={() => setEditing(true)} />
      <IconButton
        icon="refresh-cw"
        size={17}
        label={t('provider.customRefresh')}
        onPress={() => refresh.mutate()}
        disabled={refresh.isPending}
      />
      <IconButton
        icon="x"
        size={18}
        label={t('common.remove')}
        onPress={() => remove.mutate()}
        disabled={remove.isPending}
      />
    </SavedLine>
  );
}

/** Changes a saved endpoint's name, address or key; an empty key field keeps the saved key. */
function EndpointEdit({ provider: p, onDone }: { provider: ProviderInfo; onDone: () => void }) {
  const c = useColors();
  const api = useApi();
  const qc = useQueryClient();
  const { origin } = useServer();
  const [name, setName] = useState(p.custom!.name);
  const [baseUrl, setBaseUrl] = useState(p.custom!.baseUrl);
  const [key, setKey] = useState('');
  const save = useMutation({
    mutationFn: () =>
      api.updateEndpoint(p.id, { name: name.trim(), baseUrl: baseUrl.trim(), key: key.trim() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['providers', origin] });
      void qc.invalidateQueries({ queryKey: ['provider-models', origin, p.id] });
      onDone();
    },
    onError: toastError,
  });
  return (
    <View style={[styles.form, { borderColor: c.border }]}>
      <Field value={name} onChangeText={setName} accessibilityLabel={t('provider.customName')} />
      <Field
        value={baseUrl}
        onChangeText={setBaseUrl}
        keyboardType="url"
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel={t('provider.customUrl')}
      />
      <Field
        value={key}
        onChangeText={setKey}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel={t('provider.customKey')}
        placeholder={p.hint ? t('provider.customKeyKeep', { hint: p.hint }) : t('provider.customKey')}
      />
      <View style={styles.buttons}>
        <PillButton variant="ghost" label={t('common.cancel')} onPress={onDone} />
        <PillButton
          variant="primary"
          label={t('common.save')}
          onPress={() => save.mutate()}
          busy={save.isPending}
          disabled={!name.trim() || !baseUrl.trim()}
        />
      </View>
    </View>
  );
}

/**
 * Adds an OpenAI-compatible endpoint, such as Ollama or LM Studio on this network, or a hosted
 * service. The server asks it for its models; the key is optional and stays on the server.
 */
export function EndpointForm() {
  const c = useColors();
  const api = useApi();
  const qc = useQueryClient();
  const { origin } = useServer();
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [key, setKey] = useState('');
  const [models, setModels] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: () =>
      api.addEndpoint({
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        ...(key.trim() ? { key: key.trim() } : {}),
        ...(models.trim()
          ? {
              models: models
                .split(/[\s,]+/)
                .map((m) => m.trim())
                .filter(Boolean),
            }
          : {}),
      }),
    onSuccess: () => {
      setName('');
      setBaseUrl('');
      setKey('');
      setModels('');
      setError(null);
      void qc.invalidateQueries({ queryKey: ['providers', origin] });
    },
    onError: (e) => setError((e as Error).message),
  });
  // Model servers already running on the server's computer, offered with one tap.
  const { data: found = [] } = useQuery({
    queryKey: ['endpoint-discovery', origin],
    queryFn: api.discoverEndpoints,
    staleTime: 60_000,
  });
  const addFound = useMutation({
    mutationFn: (f: { name: string; baseUrl: string }) =>
      api.addEndpoint({ name: f.name, baseUrl: f.baseUrl }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['providers', origin] });
      void qc.invalidateQueries({ queryKey: ['endpoint-discovery', origin] });
    },
    onError: (e) => setError((e as Error).message),
  });
  return (
    <View style={styles.root}>
      {found.length > 0 ? (
        <View style={[styles.found, { borderColor: c.border }]}>
          <Text style={[styles.sub, { color: c.mutedForeground }]}>{t('provider.found')}</Text>
          {found.map((f) => (
            <View key={f.baseUrl} style={styles.foundRow}>
              <Feather name="server" size={16} color={c.mutedForeground} />
              <Text style={[styles.foundText, { color: c.foreground }]} numberOfLines={2}>
                {f.name}{' '}
                <Text style={[styles.sub, { color: c.mutedForeground }]}>
                  {t('provider.foundModels', { count: f.models.length })}
                </Text>
              </Text>
              <PillButton
                variant="secondary"
                label={t('common.add')}
                onPress={() => addFound.mutate(f)}
                disabled={addFound.isPending}
              />
            </View>
          ))}
        </View>
      ) : null}
      <Text style={[styles.sub, { color: c.mutedForeground }]}>{t('provider.customHint')}</Text>
      <Field
        value={name}
        onChangeText={setName}
        accessibilityLabel={t('provider.customName')}
        placeholder={t('provider.customName')}
      />
      <Field
        value={baseUrl}
        onChangeText={setBaseUrl}
        keyboardType="url"
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel={t('provider.customUrl')}
        placeholder={EXAMPLE_URL}
      />
      <Field
        value={key}
        onChangeText={setKey}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel={t('provider.customKey')}
        placeholder={t('provider.customKey')}
      />
      <Field
        value={models}
        onChangeText={setModels}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel={t('provider.customModels')}
        placeholder={t('provider.customModels')}
      />
      <PillButton
        variant="primary"
        label={t('common.add')}
        onPress={() => {
          setError(null);
          add.mutate();
        }}
        busy={add.isPending}
        disabled={!name.trim() || !baseUrl.trim()}
      />
      {error ? <Text style={[styles.sub, { color: c.destructive }]}>{error}</Text> : null}
    </View>
  );
}

/**
 * Picks one model of a provider that has a key, as `provider/model`. Lists can be long, so the
 * model is typed, with the matching names offered under the box.
 */
export function PiModelPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const c = useColors();
  const { data: providers = [] } = useProviders();
  const configured = providers.filter((p) => p.configured).map((p) => p.id);
  const parts = splitPiModel(value);
  const provider = configured.includes(parts.provider) ? parts.provider : (configured[0] ?? '');
  const model = provider === parts.provider ? parts.model : '';
  const { data: models = [] } = useProviderModels(provider || null);
  if (!configured.length) {
    return <Text style={[styles.sub, { color: c.mutedForeground }]}>{t('provider.noKey')}</Text>;
  }
  const typed = model.toLowerCase();
  const suggestions = models.filter((m) => m !== model && m.toLowerCase().includes(typed)).slice(0, 6);
  return (
    <View style={styles.root}>
      <View style={[styles.other, { borderColor: c.border }]}>
        <ChoiceRow
          label={t('provider.provider')}
          value={provider}
          options={configured.map((id) => ({
            value: id,
            label: providers.find((p) => p.id === id)?.custom?.name ?? providerName(id),
          }))}
          onChange={(p) => onChange(`${p}/`)}
        />
      </View>
      <Field
        value={model}
        onChangeText={(v) => onChange(`${provider}/${v.trim()}`)}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel={t('provider.model')}
        placeholder={models[0] ?? t('provider.model')}
      />
      {suggestions.length > 0 ? (
        <ChipRow>
          {suggestions.map((m) => (
            <Chip key={m} on={false} onPress={() => onChange(`${provider}/${m}`)} label={m} />
          ))}
        </ChipRow>
      ) : null}
    </View>
  );
}

/** Tries a `provider/model` and stores it for new bots, or as the backup model with `backup`. */
export function useSavePiModel(onSaved?: () => void, backup = false) {
  const api = useApi();
  const qc = useQueryClient();
  const { origin } = useServer();
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async (ref: string) => {
      const { provider, model } = splitPiModel(ref);
      const r = await api.testProviderModel(provider, model);
      if (!r.ok) throw new Error(r.detail);
      await api.updateSettings(backup ? { backupModel: ref } : { defaultEngine: 'pi', piModel: ref });
    },
    onMutate: () => setError(null),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings', origin] });
      onSaved?.();
    },
    onError: (e) => setError((e as Error).message),
  });
  return { save, error };
}

const styles = StyleSheet.create({
  root: { gap: 12 },
  saved: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 16,
    paddingLeft: 16,
    paddingRight: 6,
    paddingVertical: 8,
  },
  badge: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  savedText: { flex: 1, gap: 2, marginLeft: 4 },
  title: { fontSize: 15, fontWeight: '500' },
  sub: { fontSize: 13, lineHeight: 18 },
  other: { borderWidth: 1, borderRadius: 16, overflow: 'hidden' },
  form: { borderWidth: 1, borderRadius: 16, padding: 12, gap: 10 },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  found: { borderWidth: 1, borderStyle: 'dashed', borderRadius: 16, padding: 12, gap: 8 },
  foundRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  foundText: { flex: 1, fontSize: 15 },
});
