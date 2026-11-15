import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Loader2, Pencil, RefreshCw, Server, X } from 'lucide-react';
import type { ProviderInfo } from '@yumakbot/shared';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { splitPiModel } from '@/lib/new-bot';
import { useProviderModels, useProviders } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Chip } from './onboarding/Chip';

/** Offered first; every other provider the server knows is under "Other". */
const POPULAR = ['openai', 'google', 'openrouter', 'deepseek', 'xai', 'mistral', 'groq'];
/**
 * Product names, not words to translate. A provider missing here shows its id, which is also
 * how regional plans (`minimax-cn`, `xiaomi-token-plan-sgp`) stay told apart.
 */
const NAMES: Record<string, string> = {
  openai: 'OpenAI',
  google: 'Google Gemini',
  openrouter: 'OpenRouter',
  deepseek: 'DeepSeek',
  xai: 'xAI',
  mistral: 'Mistral',
  groq: 'Groq',
  anthropic: 'Anthropic',
  baseten: 'Baseten',
  cerebras: 'Cerebras',
  fireworks: 'Fireworks',
  huggingface: 'Hugging Face',
  'kimi-coding': 'Kimi Coding',
  meta: 'Meta',
  minimax: 'MiniMax',
  moonshotai: 'Moonshot AI',
  nvidia: 'NVIDIA',
  opencode: 'OpenCode',
  'opencode-go': 'OpenCode Go',
  together: 'Together AI',
  'vercel-ai-gateway': 'Vercel AI Gateway',
  xiaomi: 'Xiaomi',
  zai: 'Z.ai',
};
export const providerName = (id: string) => NAMES[id] ?? id;
const byName = (a: string, b: string) => providerName(a).localeCompare(providerName(b));
/** The chip that opens the form for the person's own endpoint; never a provider id. */
const CUSTOM = '+custom';
/** Ollama's address on the same computer; an address, not a word to translate. */
const EXAMPLE_URL = 'http://localhost:11434/v1';

/**
 * Saves an API key for a provider other than Claude. The server keeps the key; the app only
 * ever sees its last characters.
 */
export function ProviderKeyForm() {
  const t = useT();
  const qc = useQueryClient();
  const { data: providers = [], isLoading } = useProviders();
  const [provider, setProvider] = useState('');
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['providers'] });
  const save = useMutation({
    mutationFn: () => api.setProviderKey(current, key.trim()),
    onSuccess: () => {
      setKey('');
      setError(null);
      void refresh();
    },
    onError: (e) => setError((e as Error).message),
  });
  const remove = useMutation({ mutationFn: api.removeProviderKey, onSuccess: () => void refresh() });

  if (isLoading) return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
  const ids = providers.filter((p) => !p.custom).map((p) => p.id);
  const popular = POPULAR.filter((id) => ids.includes(id));
  const others = ids.filter((id) => !popular.includes(id)).sort(byName);
  const current = provider || popular[0] || ids[0] || '';
  const configured = providers.filter((p) => p.configured);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (key.trim()) save.mutate();
  };

  return (
    <div className="space-y-4">
      {configured.map((p) =>
        p.custom ? (
          <EndpointRow key={p.id} provider={p} />
        ) : (
          <div key={p.id} className="flex items-center gap-3 rounded-2xl border px-4 py-3">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
              <Check className="size-4" />
            </span>
            <span className="min-w-0 flex-1 text-sm font-medium">
              {t('provider.saved', { provider: providerName(p.id), hint: p.hint ?? '' })}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="rounded-full text-muted-foreground"
              onClick={() => remove.mutate(p.id)}
              disabled={remove.isPending}
            >
              <X /> {t('common.remove')}
            </Button>
          </div>
        ),
      )}
      <form onSubmit={submit} className="space-y-3">
        <div className="text-sm font-medium">
          {configured.length ? t('provider.addAnother') : t('provider.pick')}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {popular.map((id) => (
            <Chip
              key={id}
              on={current === id}
              onClick={() => {
                setProvider(id);
                setError(null);
              }}
            >
              {providerName(id)}
            </Chip>
          ))}
          {others.length > 0 && (
            <Select
              value={others.includes(current) ? current : ''}
              onValueChange={(id) => {
                setProvider(id);
                setError(null);
              }}
            >
              <SelectTrigger
                className={cn(
                  'h-9 w-auto min-w-28 rounded-full',
                  others.includes(current) && 'border-[var(--brand)]/60 bg-[var(--brand)]/10',
                )}
                aria-label={t('provider.other')}
              >
                <SelectValue placeholder={t('provider.other')} />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {others.map((id) => (
                  <SelectItem key={id} value={id}>
                    {providerName(id)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Chip
            on={current === CUSTOM}
            onClick={() => {
              setProvider(CUSTOM);
              setError(null);
            }}
          >
            <Server className="size-3.5" /> {t('provider.custom')}
          </Chip>
        </div>
        {current === CUSTOM ? (
          <EndpointForm />
        ) : (
          <div className="flex flex-wrap gap-2">
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              onChange={(e) => {
                setKey(e.target.value);
                setError(null);
              }}
              aria-label={t('provider.keyFor', { provider: providerName(current) })}
              placeholder={t('provider.keyFor', { provider: providerName(current) })}
              className="h-10 min-w-56 flex-1 rounded-full px-4 font-mono"
            />
            <Button type="submit" className="h-10 rounded-full" disabled={!key.trim() || save.isPending}>
              {save.isPending && <Loader2 className="animate-spin" />}
              {t('common.save')}
            </Button>
          </div>
        )}
        {error && current !== CUSTOM && <p className="text-sm text-destructive">{error}</p>}
      </form>
    </div>
  );
}

/** One of the person's own endpoints: its name, where it is, and its model list on request. */
export function EndpointRow({ provider: p }: { provider: ProviderInfo }) {
  const t = useT();
  const qc = useQueryClient();
  const refresh = useMutation({
    mutationFn: () => api.refreshEndpoint(p.id),
    onSuccess: (models) => {
      qc.setQueryData(['provider-models', p.id], models);
      toast.success(t('provider.customRefreshed', { count: models.length }));
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: () => api.removeEndpoint(p.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['providers'] }),
    onError: (e) => toast.error((e as Error).message),
  });
  const [editing, setEditing] = useState(false);
  if (editing) return <EndpointEdit provider={p} onDone={() => setEditing(false)} />;
  return (
    <div className="flex items-center gap-3 rounded-2xl border px-4 py-3">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
        <Server className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{p.custom!.name}</span>
        <span className="block truncate font-mono text-xs text-muted-foreground">
          {p.custom!.baseUrl}
          {p.hint ? ` · ${p.hint}` : ''}
        </span>
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="rounded-full text-muted-foreground"
        aria-label={t('provider.customEdit')}
        title={t('provider.customEdit')}
        onClick={() => setEditing(true)}
      >
        <Pencil />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="rounded-full text-muted-foreground"
        aria-label={t('provider.customRefresh')}
        title={t('provider.customRefresh')}
        onClick={() => refresh.mutate()}
        disabled={refresh.isPending}
      >
        <RefreshCw className={cn(refresh.isPending && 'animate-spin')} />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="rounded-full text-muted-foreground"
        onClick={() => remove.mutate()}
        disabled={remove.isPending}
      >
        <X /> {t('common.remove')}
      </Button>
    </div>
  );
}

/** Model names typed into one field, split at commas and spaces. */
const modelList = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((m) => m.trim())
    .filter(Boolean);

/**
 * Changes a saved endpoint's name, address, key or models; an empty key field keeps the saved
 * key. The models start as the saved list, so one the server leaves out can be added by hand.
 */
function EndpointEdit({ provider: p, onDone }: { provider: ProviderInfo; onDone(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState(p.custom!.name);
  const [baseUrl, setBaseUrl] = useState(p.custom!.baseUrl);
  const [key, setKey] = useState('');
  const { data: saved = [] } = useProviderModels(p.id);
  // Null until edited: the saved list may still be loading, and an untouched list is not sent.
  const [models, setModels] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      api.updateEndpoint(p.id, {
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        key: key.trim(),
        ...(models !== null ? { models: modelList(models) } : {}),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['providers'] });
      void qc.invalidateQueries({ queryKey: ['provider-models', p.id] });
      onDone();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <form
      className="space-y-2 rounded-2xl border px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() && baseUrl.trim()) save.mutate();
      }}
    >
      <div className="flex flex-wrap gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label={t('provider.customName')}
          className="h-10 w-40 rounded-full px-4"
        />
        <Input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          aria-label={t('provider.customUrl')}
          spellCheck={false}
          className="h-10 min-w-56 flex-1 rounded-full px-4 font-mono"
        />
      </div>
      <Input
        value={models ?? saved.join(', ')}
        onChange={(e) => setModels(e.target.value)}
        aria-label={t('provider.customModelsEdit')}
        placeholder={t('provider.customModelsEdit')}
        title={t('provider.customModelsEdit')}
        spellCheck={false}
        className="h-10 rounded-full px-4 font-mono"
      />
      <div className="flex flex-wrap gap-2">
        <Input
          type="password"
          autoComplete="off"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          aria-label={t('provider.customKey')}
          placeholder={p.hint ? t('provider.customKeyKeep', { hint: p.hint }) : t('provider.customKey')}
          className="h-10 min-w-40 flex-1 rounded-full px-4 font-mono"
        />
        <Button type="button" variant="ghost" className="h-10 rounded-full" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button
          type="submit"
          className="h-10 rounded-full"
          disabled={save.isPending || !name.trim() || !baseUrl.trim()}
        >
          {save.isPending && <Loader2 className="animate-spin" />}
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
}

/**
 * Adds an OpenAI-compatible endpoint, such as Ollama or LM Studio on this network, or a hosted
 * service. The server asks it for its models; the key is optional and stays on the server.
 */
export function EndpointForm() {
  const t = useT();
  const qc = useQueryClient();
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
        ...(models.trim() ? { models: modelList(models) } : {}),
      }),
    onSuccess: () => {
      setName('');
      setBaseUrl('');
      setKey('');
      setModels('');
      setError(null);
      void qc.invalidateQueries({ queryKey: ['providers'] });
    },
    onError: (e) => setError((e as Error).message),
  });
  const ready = !!name.trim() && !!baseUrl.trim() && !add.isPending;
  // Model servers already running on the server's computer, offered with one click.
  const { data: found = [] } = useQuery({
    queryKey: ['endpoint-discovery'],
    queryFn: api.discoverEndpoints,
    staleTime: 60_000,
  });
  const addFound = useMutation({
    mutationFn: (f: { name: string; baseUrl: string }) =>
      api.addEndpoint({ name: f.name, baseUrl: f.baseUrl }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['providers'] });
      void qc.invalidateQueries({ queryKey: ['endpoint-discovery'] });
    },
    onError: (e) => setError((e as Error).message),
  });
  return (
    <div className="space-y-2">
      {found.length > 0 && (
        <div className="space-y-1.5 rounded-2xl border border-dashed p-3">
          <div className="text-xs font-medium text-muted-foreground">{t('provider.found')}</div>
          {found.map((f) => (
            <div key={f.baseUrl} className="flex items-center gap-3">
              <Server className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-sm">
                {f.name}{' '}
                <span className="text-xs text-muted-foreground">
                  {t('provider.foundModels', { count: f.models.length })}
                </span>
              </span>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="rounded-full"
                disabled={addFound.isPending}
                onClick={() => addFound.mutate(f)}
              >
                {t('common.add')}
              </Button>
            </div>
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">{t('provider.customHint')}</p>
      <div className="flex flex-wrap gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label={t('provider.customName')}
          placeholder={t('provider.customName')}
          className="h-10 w-40 rounded-full px-4"
        />
        <Input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          aria-label={t('provider.customUrl')}
          placeholder={EXAMPLE_URL}
          spellCheck={false}
          className="h-10 min-w-56 flex-1 rounded-full px-4 font-mono"
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          aria-label={t('provider.customKey')}
          placeholder={t('provider.customKey')}
          className="h-10 min-w-40 flex-1 rounded-full px-4 font-mono"
        />
        <Input
          value={models}
          onChange={(e) => setModels(e.target.value)}
          aria-label={t('provider.customModels')}
          placeholder={t('provider.customModels')}
          spellCheck={false}
          className="h-10 min-w-40 flex-1 rounded-full px-4 font-mono"
        />
        <Button
          type="button"
          className="h-10 rounded-full"
          disabled={!ready}
          onClick={() => {
            setError(null);
            add.mutate();
          }}
        >
          {add.isPending && <Loader2 className="animate-spin" />}
          {t('common.add')}
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

/** True once a provider can be used: it has a key, or it is the person's own endpoint. */
export function useHasProvider() {
  const { data: providers = [] } = useProviders();
  return providers.some((p) => p.configured);
}

/**
 * Picks one model of a provider that has a key, as `provider/model`. Lists can be long, so the
 * model is typed with suggestions instead of picked from cards. With no provider yet it asks for
 * one right here, so the way on is not somewhere else on the page.
 */
export function PiModelPicker({ value, onChange }: { value: string; onChange(v: string): void }) {
  const t = useT();
  const { data: providers = [] } = useProviders();
  const configured = providers.filter((p) => p.configured).map((p) => p.id);
  const parts = splitPiModel(value);
  const provider = configured.includes(parts.provider) ? parts.provider : (configured[0] ?? '');
  const model = provider === parts.provider ? parts.model : '';
  const { data: models = [] } = useProviderModels(provider || null);
  if (!configured.length) return <ProviderKeyForm />;
  const listId = 'pi-model-options';
  return (
    <div className="flex flex-wrap gap-2">
      <Select value={provider} onValueChange={(p) => onChange(`${p}/`)}>
        <SelectTrigger className="h-10 w-44 rounded-full" aria-label={t('provider.provider')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {configured.map((id) => (
            <SelectItem key={id} value={id}>
              {providers.find((p) => p.id === id)?.custom?.name ?? providerName(id)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        list={listId}
        value={model}
        onChange={(e) => onChange(`${provider}/${e.target.value.trim()}`)}
        aria-label={t('provider.model')}
        placeholder={models[0] ?? t('provider.model')}
        spellCheck={false}
        className="h-10 min-w-56 flex-1 rounded-full px-4 font-mono"
      />
      <datalist id={listId}>
        {models.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </div>
  );
}

/** Tries the model with one short request, then makes it what new bots start with. */
/** Tries a `provider/model` and stores it for new bots, or as the backup model with `backup`. */
export function useSavePiModel(onSaved?: () => void, backup = false) {
  const qc = useQueryClient();
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
      void qc.invalidateQueries({ queryKey: ['settings'] });
      onSaved?.();
    },
    onError: (e) => setError((e as Error).message),
  });
  return { save, error };
}

/** True when `provider/model` names both parts. */
export function isPiModel(ref: string) {
  const { provider, model } = splitPiModel(ref);
  return !!provider && !!model;
}
