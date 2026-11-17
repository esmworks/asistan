import { describeSchedule, type BotImportPlan } from '@yumakbot/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArchiveRestore, Copy, Download, FileUp, Loader2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useLocale, useT, type MessageKey } from '@/i18n';
import { api } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import { useFormat } from '@/lib/format';
import { useBots } from '@/lib/queries';
import { FoundProjects } from './FoundProjects';
import { Card, Row } from './SettingsDialog';

/** The instructions the other app follows to write the import file; served with the app. */
const EXPORT_INSTRUCTIONS = '/import/grok-bot-export.md';

/**
 * Bots from Grok Bot: the person runs the export instructions there, then picks the file it
 * writes. Everything in it is shown before anything is saved.
 */
export function ImportTab() {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [plan, setPlan] = useState<BotImportPlan | null>(null);

  const reset = () => {
    setFile(null);
    setPlan(null);
    if (input.current) input.current.value = '';
  };
  const preview = useMutation({
    mutationFn: api.previewBotImport,
    onSuccess: setPlan,
    onError: (e) => {
      reset();
      toast.error((e as Error).message);
    },
  });
  const commit = useMutation({
    mutationFn: api.importBots,
    onSuccess: (result) => {
      toast.success(t('import.done', { count: result.botIds.length }));
      reset();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  // Loaded ahead so the click copies at once: a copy that waits on the network is no longer the
  // click's, and Safari refuses it.
  const instructions = useQuery({
    queryKey: ['import-instructions'],
    queryFn: async () => {
      const res = await fetch(EXPORT_INSTRUCTIONS);
      if (!res.ok) throw new Error(String(res.status));
      return res.text();
    },
    staleTime: Infinity,
  });
  const copyInstructions = async () => {
    const text = instructions.data ?? (await instructions.refetch()).data;
    if (text && (await copyText(text))) toast.success(t('import.copied'));
    else toast.error(t('import.copyFailed'));
  };

  return (
    <>
      <p className="mb-4 text-sm text-muted-foreground">{t('import.hint')}</p>
      <Card title={t('import.step1')}>
        <Row label={t('import.instructions')} hint={t('import.instructionsHint')}>
          <Button
            variant="outline"
            size="sm"
            className="rounded-full"
            onClick={() => void copyInstructions()}
          >
            <Copy className="size-4" />
            {t('import.copy')}
          </Button>
          <Button variant="ghost" size="icon" className="size-8 rounded-full" asChild>
            <a href={EXPORT_INSTRUCTIONS} download="yumakbot-export.md" aria-label={t('import.download')}>
              <Download className="size-4" />
            </a>
          </Button>
        </Row>
      </Card>
      <Card title={t('import.step2')}>
        <Row label={file?.name ?? t('import.file')} hint={t('import.fileHint')}>
          <input
            ref={input}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const picked = e.target.files?.[0];
              if (!picked) return;
              setFile(picked);
              setPlan(null);
              preview.mutate(picked);
            }}
          />
          <Button
            variant="outline"
            size="sm"
            className="rounded-full"
            disabled={preview.isPending || commit.isPending}
            onClick={() => input.current?.click()}
          >
            {preview.isPending ? <Loader2 className="size-4 animate-spin" /> : <FileUp className="size-4" />}
            {t('import.choose')}
          </Button>
        </Row>
      </Card>

      {plan && file && (
        <>
          <p className="mb-4 text-sm text-muted-foreground">{t('import.safety')}</p>
          <Card title={t('import.bots', { count: plan.bots.length })}>
            {plan.bots.map((bot) => (
              <details key={bot.ref} className="group px-4 py-3">
                <summary className="cursor-pointer list-none">
                  <div className="text-sm font-medium">{bot.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {[
                      bot.description,
                      bot.name !== bot.nameInFile && t('import.renamed', { name: bot.nameInFile }),
                      bot.group && t('import.inGroup', { group: bot.group }),
                      t('import.counts', {
                        routines: bot.routines.length,
                        memories: bot.memories.length,
                        skills: bot.skills?.length ?? 0,
                      }),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </summary>
                <div className="mt-3 space-y-3 text-sm">
                  <section>
                    <h4 className="mb-1 text-xs font-medium text-muted-foreground">
                      {t('import.instructionsOf')}
                    </h4>
                    <pre className="max-h-64 overflow-y-auto rounded-xl bg-muted p-3 font-sans text-xs whitespace-pre-wrap">
                      {bot.instructions || t('import.none')}
                    </pre>
                  </section>
                  {bot.routines.length > 0 && (
                    <section>
                      <h4 className="mb-1 text-xs font-medium text-muted-foreground">
                        {t('import.routines')}
                      </h4>
                      <ul className="space-y-2">
                        {bot.routines.map((r, i) => (
                          <li key={i}>
                            <div className="text-xs font-medium">
                              {r.name} · {describeSchedule(r.schedule, locale)}
                            </div>
                            <div className="text-xs whitespace-pre-wrap text-muted-foreground">
                              {r.prompt}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}
                  {(bot.skills?.length ?? 0) > 0 && (
                    <section>
                      <h4 className="mb-1 text-xs font-medium text-muted-foreground">{t('import.skills')}</h4>
                      <ul className="space-y-1 text-xs">
                        {bot.skills.map((k) => (
                          <li key={k.name}>
                            <span className="font-medium">{k.name}</span>
                            {' · '}
                            {k.existing ? t('import.skillExists') : k.description}
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}
                  {bot.memories.length > 0 && (
                    <section>
                      <h4 className="mb-1 text-xs font-medium text-muted-foreground">
                        {t('import.memories')}
                      </h4>
                      <ul className="list-disc space-y-1 pl-5 text-xs">
                        {bot.memories.map((m, i) => (
                          <li key={i}>{m}</li>
                        ))}
                      </ul>
                    </section>
                  )}
                </div>
              </details>
            ))}
          </Card>
          {plan.groups.length > 0 && (
            <Card title={t('import.groups')}>
              {plan.groups.map((g) => (
                <Row
                  key={g.name}
                  label={g.name}
                  hint={g.members.map((ref) => plan.bots.find((b) => b.ref === ref)?.name ?? ref).join(', ')}
                />
              ))}
            </Card>
          )}
          {(plan.warnings.length > 0 || plan.notImported.length > 0) && (
            <Card title={t('import.leftOut')}>
              {plan.warnings.map((w, i) => (
                <Row key={`w${i}`} label={t(w.key as MessageKey, w.params)} />
              ))}
              {plan.notImported.map((n, i) => (
                <Row
                  key={`n${i}`}
                  label={n.what}
                  hint={[n.bot && (plan.bots.find((b) => b.ref === n.bot)?.name ?? n.bot), n.reason]
                    .filter(Boolean)
                    .join(' · ')}
                />
              ))}
            </Card>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" className="rounded-full" onClick={reset} disabled={commit.isPending}>
              {t('common.cancel')}
            </Button>
            <Button className="rounded-full" onClick={() => commit.mutate(file)} disabled={commit.isPending}>
              {commit.isPending && <Loader2 className="size-4 animate-spin" />}
              {t('import.confirm', { count: plan.bots.length })}
            </Button>
          </div>
        </>
      )}
      <FoundProjects />
      <ExportCard />
      <BackupCard />
    </>
  );
}

/** The smallest backup password the server takes. */
const MIN_PASSWORD = 12;

/**
 * Everything on the server in one file sealed with a password: to keep a copy, or to move to
 * another computer. Restoring replaces everything with what the file holds.
 */
function BackupCard() {
  const t = useT();
  const fmt = useFormat();
  const [password, setPassword] = useState('');
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restorePassword, setRestorePassword] = useState('');
  const picker = useRef<HTMLInputElement>(null);
  const create = useMutation({
    mutationFn: () => api.createBackup(password),
    onSuccess: ({ id, size }) => {
      // A plain link, so a large file streams to disk instead of through the page.
      const a = document.createElement('a');
      a.href = `/api/backup/${id}`;
      a.download = '';
      document.body.append(a);
      a.click();
      a.remove();
      setPassword('');
      toast.success(t('backup.ready', { size: fmt.fileSize(size) }));
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const restore = useMutation({
    mutationFn: () => api.restoreBackup(restoreFile!, restorePassword),
    onSuccess: () => {
      toast.success(t('backup.restored'));
      // The server starts again with the restored data; the page follows once it is back.
      setTimeout(() => window.location.reload(), 4000);
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Card title={t('backup.title')}>
      <p className="px-4 py-3 text-xs text-muted-foreground">{t('backup.hint')}</p>
      <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
        <Input
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t('backup.passwordPlaceholder', { count: MIN_PASSWORD })}
          aria-label={t('backup.password')}
          className="min-w-0 flex-1 rounded-xl"
        />
        <Button
          size="sm"
          className="rounded-full"
          disabled={password.length < MIN_PASSWORD || create.isPending}
          onClick={() => create.mutate()}
        >
          {create.isPending ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
          {t('backup.download')}
        </Button>
      </div>
      <Row label={t('backup.restoreTitle')} hint={t('backup.restoreHint')}>
        <input
          ref={picker}
          type="file"
          accept=".ybk"
          className="hidden"
          onChange={(e) => setRestoreFile(e.target.files?.[0] ?? null)}
        />
        <Button variant="outline" size="sm" className="rounded-full" onClick={() => picker.current?.click()}>
          <FileUp className="size-4" />
          {restoreFile ? restoreFile.name : t('backup.pick')}
        </Button>
      </Row>
      {restoreFile && (
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <Input
            type="password"
            autoComplete="off"
            value={restorePassword}
            onChange={(e) => setRestorePassword(e.target.value)}
            placeholder={t('backup.password')}
            aria-label={t('backup.password')}
            className="min-w-0 flex-1 rounded-xl"
          />
          <Button
            size="sm"
            variant="destructive"
            className="rounded-full"
            disabled={!restorePassword || restore.isPending}
            onClick={() => {
              if (window.confirm(t('backup.restoreConfirm'))) restore.mutate();
            }}
          >
            {restore.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ArchiveRestore className="size-4" />
            )}
            {t('backup.restore')}
          </Button>
        </div>
      )}
    </Card>
  );
}

/** Bots written to an import file, to move them to another YumakBot or keep a copy. */
function ExportCard() {
  const t = useT();
  const { data: bots = [] } = useBots();
  const [off, setOff] = useState<Set<string>>(new Set());
  const picked = bots.filter((b) => !off.has(b.id));
  if (!bots.length) return null;
  const href = `/api/export/bots?ids=${picked.map((b) => b.id).join(',')}`;
  return (
    <Card title={t('export.title')}>
      <p className="px-4 py-3 text-xs text-muted-foreground">{t('export.hint')}</p>
      {bots.map((b) => (
        <Row key={b.id} label={b.name}>
          <Switch
            checked={!off.has(b.id)}
            onCheckedChange={(on) =>
              setOff((prev) => {
                const next = new Set(prev);
                if (on) next.delete(b.id);
                else next.add(b.id);
                return next;
              })
            }
            aria-label={b.name}
          />
        </Row>
      ))}
      <div className="flex justify-end px-4 py-3">
        {picked.length ? (
          <Button size="sm" className="rounded-full" asChild>
            <a href={href} download>
              <Download className="size-4" />
              {t('export.download', { count: picked.length })}
            </a>
          </Button>
        ) : (
          <Button size="sm" className="rounded-full" disabled>
            <Download className="size-4" />
            {t('export.download', { count: 0 })}
          </Button>
        )}
      </div>
    </Card>
  );
}
