import type { ApiKeyImportResult, VaultImportReason, VaultImportResult } from '@yumakbot/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileUp } from 'lucide-react';
import { useState, type ChangeEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useManagesServer } from '@/lib/queries';
import { BotAccess, TeamChoice } from './VaultTab';

/** Reads a chosen file as text; the file never leaves for anywhere but this server. */
const readFile = (e: ChangeEvent<HTMLInputElement>) => e.target.files?.[0]?.text() ?? Promise.resolve(null);

/**
 * Sign-ins from a passwords file a browser or a password manager exported (CSV). First a preview of
 * what would be added and what would be left out, and why; nothing is saved until the person says.
 * The file is kept only in this form, and dropped when it closes.
 */
export function VaultCsvImport({ onDone }: { onDone(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const manages = useManagesServer();
  const [csv, setCsv] = useState<string | null>(null);
  const [preview, setPreview] = useState<VaultImportResult | null>(null);
  const [botIds, setBotIds] = useState<string[] | null>(null);
  const [team, setTeam] = useState(false);
  const run = useMutation({
    mutationFn: (apply: boolean) =>
      api.importVault({ csv: csv!, apply, botIds, ...(manages && team && { team }) }),
    onSuccess: (r, apply) => {
      if (!apply) return setPreview(r);
      void qc.invalidateQueries({ queryKey: ['vault'] });
      toast.success(t('vaultImport.saved', { count: r.saved }));
      onDone();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const choose = async (e: ChangeEvent<HTMLInputElement>) => {
    const text = await readFile(e);
    setPreview(null);
    setCsv(text);
    if (text) run.mutate(false);
  };
  const reason = (r: VaultImportReason) => t(`vaultImport.reason.${r}`);
  return (
    <div className="space-y-3 rounded-2xl border bg-background p-3">
      <div className="text-sm font-medium">{t('vaultImport.title')}</div>
      <p className="text-xs text-muted-foreground">{t('vaultImport.hint')}</p>
      <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-dashed px-3 py-3 text-sm">
        <FileUp className="size-4 text-muted-foreground" />
        <span className="flex-1">{t('vaultImport.choose')}</span>
        <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => void choose(e)} />
      </label>
      {preview && (
        <>
          <div className="text-sm">{t('vaultImport.willAdd', { count: preview.add.length })}</div>
          {preview.add.length > 0 && (
            <ul className="max-h-48 divide-y overflow-y-auto rounded-xl border text-sm">
              {preview.add.map((a) => (
                <li key={a.line} className="flex gap-2 px-3 py-1.5">
                  <span className="min-w-0 flex-1 truncate">{a.site}</span>
                  <span className="truncate text-muted-foreground">
                    {a.username || t('vault.noUsername')}
                  </span>
                  {a.hasTotp && <span className="text-muted-foreground">{t('vault.hasTotp')}</span>}
                </li>
              ))}
            </ul>
          )}
          {preview.totpDropped > 0 && (
            <p className="text-xs text-muted-foreground">
              {t('vaultImport.totpDropped', { count: preview.totpDropped })}
            </p>
          )}
          {preview.skipped.length > 0 && (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">
                {t('vaultImport.skipped', { count: preview.skipped.length })}
              </summary>
              <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto">
                {preview.skipped.map((s) => (
                  <li key={s.line}>
                    {t('vaultImport.line', { line: s.line })} · {s.site || '-'} · {reason(s.reason)}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <BotAccess botIds={botIds} onChange={setBotIds} />
          {manages && <TeamChoice team={team} onChange={setTeam} />}
        </>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" className="rounded-full" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button
          type="button"
          className="rounded-full"
          disabled={!preview?.add.length || run.isPending}
          onClick={() => run.mutate(true)}
        >
          {t('vaultImport.add', { count: preview?.add.length ?? 0 })}
        </Button>
      </div>
    </div>
  );
}

interface Pick {
  on: boolean;
  name: string;
  origin: string;
}

/**
 * API keys from a `.env` file: the server names the file's entries (never their values), the
 * person ticks the ones to keep and says where each goes. Each is sent as a bearer token; another
 * way can be set on the key afterwards.
 */
export function EnvImport({ onDone }: { onDone(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const manages = useManagesServer();
  const [env, setEnv] = useState<string | null>(null);
  const [entries, setEntries] = useState<ApiKeyImportResult['entries']>([]);
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [botIds, setBotIds] = useState<string[] | null>(null);
  const [team, setTeam] = useState(manages);
  const look = useMutation({
    mutationFn: (text: string) => api.importApiKeys({ env: text }),
    onSuccess: (r) => {
      setEntries(r.entries);
      setPicks(Object.fromEntries(r.entries.map((e) => [e.env, { on: false, name: e.name, origin: '' }])));
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const chosen = entries.filter((e) => picks[e.env]?.on);
  const save = useMutation({
    mutationFn: () =>
      api.importApiKeys({
        env: env!,
        keys: chosen.map((e) => ({ env: e.env, name: picks[e.env]!.name, origin: picks[e.env]!.origin })),
        botIds,
        team: manages && team,
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['api-keys'] });
      toast.success(t('envImport.saved', { count: r.saved.length }));
      for (const s of r.skipped) toast.error(t(`envImport.skip.${s.reason}`, { name: s.env }));
      onDone();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const choose = async (e: ChangeEvent<HTMLInputElement>) => {
    const text = await readFile(e);
    setEnv(text);
    setEntries([]);
    if (text) look.mutate(text);
  };
  const set = (envName: string, patch: Partial<Pick>) =>
    setPicks((p) => ({ ...p, [envName]: { ...p[envName]!, ...patch } }));
  return (
    <div className="space-y-3 rounded-2xl border bg-background p-3">
      <div className="text-sm font-medium">{t('envImport.title')}</div>
      <p className="text-xs text-muted-foreground">{t('envImport.hint')}</p>
      <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-dashed px-3 py-3 text-sm">
        <FileUp className="size-4 text-muted-foreground" />
        <span className="flex-1">{t('envImport.choose')}</span>
        <input type="file" className="sr-only" onChange={(e) => void choose(e)} />
      </label>
      {env !== null && !look.isPending && !entries.length && (
        <p className="text-sm text-muted-foreground">{t('envImport.none')}</p>
      )}
      {entries.length > 0 && (
        <div className="space-y-2">
          {entries.map((e) => {
            const p = picks[e.env]!;
            return (
              <div key={e.env} className="space-y-1.5 rounded-xl border px-3 py-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={p.on}
                    onChange={(x) => set(e.env, { on: x.target.checked })}
                  />
                  <span className="truncate font-mono text-xs">{e.env}</span>
                </label>
                {p.on && (
                  <div className="flex gap-2">
                    <Input
                      value={p.name}
                      onChange={(x) => set(e.env, { name: x.target.value })}
                      placeholder={t('apiKeys.name')}
                      aria-label={t('apiKeys.name')}
                      className="w-40"
                    />
                    <Input
                      value={p.origin}
                      onChange={(x) => set(e.env, { origin: x.target.value })}
                      placeholder={t('apiKeys.origin')}
                      aria-label={t('apiKeys.origin')}
                    />
                  </div>
                )}
              </div>
            );
          })}
          <BotAccess botIds={botIds} onChange={setBotIds} />
          {manages && <TeamChoice team={team} onChange={setTeam} />}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" className="rounded-full" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button
          type="button"
          className="rounded-full"
          disabled={!chosen.length || chosen.some((e) => !picks[e.env]!.origin.trim()) || save.isPending}
          onClick={() => save.mutate()}
        >
          {t('envImport.add', { count: chosen.length })}
        </Button>
      </div>
    </div>
  );
}
