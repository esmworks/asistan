import { parseSkillFile, skillWarnings, type Skill } from '@yumakbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileUp, Import, Link2, Pencil, Plus, Puzzle, ShieldAlert, Sparkles, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { BotAvatar } from '@/components/BotAvatar';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useBots, useSkills } from '@/lib/queries';
import { Card } from './SettingsDialog';
import { PluginDialog } from './PluginDialog';

/** Largest SKILL.md read from disk; a skill is instructions, not a document store. */
const MAX_FILE = 200_000;

/** The skill library: write or import skills, and choose which bots have each one. */
export function SkillsTab() {
  const t = useT();
  const { data: skills = [], isPending } = useSkills();
  const [editing, setEditing] = useState<Skill | 'new' | null>(null);
  const [draft, setDraft] = useState<{ name: string; description: string; body: string } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [bringOpen, setBringOpen] = useState(false);
  const [pluginOpen, setPluginOpen] = useState(false);
  // What the person's other AI tools on this computer have; only on their own computer.
  const { data: found } = useQuery({ queryKey: ['setup-import'], queryFn: api.setupImport });
  const offered = found?.available && (found.skills.length > 0 || found.servers.length > 0);
  const [link, setLink] = useState('');
  const fromLink = useMutation({
    mutationFn: api.fetchSkill,
    onSuccess: ({ text, name }) => {
      setDraft(parseSkillFile(text, name));
      setEditing('new');
      setLink('');
      setLinkOpen(false);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const importFiles = async (files: FileList | null) => {
    const [f] = files ?? [];
    if (!f) return;
    if (f.size > MAX_FILE) return void toast.error(t('skills.fileTooLarge'));
    const parsed = parseSkillFile(await f.text(), f.name === 'SKILL.md' ? '' : f.name);
    setDraft(parsed);
    setEditing('new');
  };

  return (
    <>
      <p className="mb-4 text-sm text-muted-foreground">{t('skills.intro')}</p>
      <div className="mb-6 flex flex-wrap gap-2">
        <Button
          className="rounded-full"
          onClick={() => {
            setDraft(null);
            setEditing('new');
          }}
        >
          <Plus /> {t('skills.new')}
        </Button>
        <Button variant="secondary" className="rounded-full" onClick={() => file.current?.click()}>
          <FileUp /> {t('skills.import')}
        </Button>
        <Button variant="secondary" className="rounded-full" onClick={() => setLinkOpen((v) => !v)}>
          <Link2 /> {t('skills.importLink')}
        </Button>
        <Button variant="secondary" className="rounded-full" onClick={() => setPluginOpen(true)}>
          <Puzzle /> {t('plugin.add')}
        </Button>
        {offered && (
          <Button variant="secondary" className="rounded-full" onClick={() => setBringOpen(true)}>
            <Import /> {t('skills.bringIn')}
          </Button>
        )}
        <input
          ref={file}
          type="file"
          accept=".md,.markdown,.txt,text/markdown,text/plain"
          className="hidden"
          onChange={(e) => {
            void importFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
      {linkOpen && (
        <form
          className="mb-6 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (link.trim()) fromLink.mutate(link.trim());
          }}
        >
          <Input
            autoFocus
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder={t('skills.linkPlaceholder')}
            className="flex-1 rounded-full"
          />
          <Button className="rounded-full" disabled={!link.trim() || fromLink.isPending}>
            {t('skills.linkFetch')}
          </Button>
        </form>
      )}
      <Card>
        {!isPending && skills.length === 0 && (
          <div className="px-4 py-6 text-sm text-muted-foreground">{t('skills.empty')}</div>
        )}
        {skills.map((s) => (
          <SkillRow key={s.id} skill={s} onEdit={() => setEditing(s)} />
        ))}
      </Card>
      {bringOpen && found && <BringInDialog found={found} onClose={() => setBringOpen(false)} />}
      {pluginOpen && <PluginDialog onClose={() => setPluginOpen(false)} />}
      {editing && (
        <SkillDialog
          skill={editing === 'new' ? null : editing}
          draft={editing === 'new' ? draft : null}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function SkillRow({ skill, onEdit }: { skill: Skill; onEdit(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: bots = [] } = useBots();
  const remove = useMutation({
    mutationFn: () => api.removeSkill(skill.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['skills'] }),
    onError: (e) => toast.error((e as Error).message),
  });
  const holders = bots.filter((b) => skill.botIds.includes(b.id));
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <Sparkles className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="font-mono text-sm">{skill.name}</div>
        <div className="line-clamp-2 text-xs text-muted-foreground">{skill.description}</div>
        <div className="mt-1.5 flex items-center gap-1">
          {holders.length === 0 ? (
            <span className="text-xs text-muted-foreground">{t('skills.noBots')}</span>
          ) : (
            holders.map((b) => (
              <span key={b.id} title={b.name}>
                <BotAvatar avatar={b.avatar} color={b.color} seed={b.id} size={20} />
              </span>
            ))
          )}
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="rounded-full"
        aria-label={t('skills.edit')}
        onClick={onEdit}
      >
        <Pencil />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="rounded-full text-muted-foreground"
        aria-label={t('common.delete')}
        disabled={remove.isPending}
        onClick={() => confirm(t('skills.confirmDelete', { name: skill.name })) && remove.mutate()}
      >
        <Trash2 />
      </Button>
    </div>
  );
}

/** Writes or edits one skill, and picks the bots that have it. */
function SkillDialog({
  skill,
  draft,
  onClose,
}: {
  skill: Skill | null;
  draft: { name: string; description: string; body: string } | null;
  onClose(): void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const { data: bots = [] } = useBots();
  const start = skill ?? draft;
  const [name, setName] = useState(start?.name ?? '');
  const [description, setDescription] = useState(start?.description ?? '');
  const [body, setBody] = useState(start?.body ?? '');
  const [botIds, setBotIds] = useState<string[]>(skill?.botIds ?? []);
  const save = useMutation({
    mutationFn: async () => {
      const fields = { name: name.trim(), description: description.trim(), body };
      if (!skill) return api.createSkill({ ...fields, botIds });
      const saved = await api.updateSkill(skill.id, fields);
      for (const b of bots) {
        const on = botIds.includes(b.id);
        if (on !== skill.botIds.includes(b.id)) await api.setSkillBot(skill.id, b.id, on);
      }
      return saved;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['skills'] });
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const ready = !!name.trim() && !!description.trim() && !save.isPending;
  // What the skill's text may hide; read before the skill goes to any bot.
  const warnings = skillWarnings(`${name}\n${description}\n${body}`);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto rounded-3xl sm:max-w-2xl">
        <DialogTitle>{skill ? t('skills.edit') : t('skills.new')}</DialogTitle>
        <DialogDescription>{t('skills.dialogHint')}</DialogDescription>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) save.mutate();
          }}
        >
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">{t('skills.name')}</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, '-'))}
              placeholder={t('skills.namePlaceholder')}
              spellCheck={false}
              className="rounded-xl font-mono"
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">{t('skills.description')}</span>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('skills.descriptionPlaceholder')}
              className="rounded-xl"
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">{t('skills.body')}</span>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={t('skills.bodyPlaceholder')}
              className="min-h-48 rounded-xl font-mono text-sm"
            />
          </label>
          {warnings.length > 0 && (
            <div
              role="alert"
              className="flex gap-2 rounded-xl border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm"
            >
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
              <ul className="space-y-1">
                {warnings.map((w) => (
                  <li key={w}>{t(`skills.warn.${w}`)}</li>
                ))}
              </ul>
            </div>
          )}
          {bots.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-sm font-medium">{t('skills.bots')}</div>
              <div className="divide-y rounded-2xl border">
                {bots.map((b) => (
                  <label key={b.id} className="flex items-center gap-3 px-3 py-2">
                    <BotAvatar avatar={b.avatar} color={b.color} seed={b.id} size={24} />
                    <span className="min-w-0 flex-1 truncate text-sm">{b.name}</span>
                    <Switch
                      checked={botIds.includes(b.id)}
                      onCheckedChange={(on) =>
                        setBotIds((ids) => (on ? [...ids, b.id] : ids.filter((id) => id !== b.id)))
                      }
                      aria-label={b.name}
                    />
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" className="rounded-full" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" className="rounded-full" disabled={!ready}>
              {t('common.save')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Picks what to bring in from the person's other AI tools. Skills whose text looks off start
 * unticked and say why; everything comes in switched off, for no bot until the person chooses.
 */
function BringInDialog({
  found,
  onClose,
}: {
  found: Awaited<ReturnType<typeof api.setupImport>>;
  onClose(): void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [skills, setSkills] = useState(() =>
    found.skills.filter((k) => !k.warnings.length).map((k) => k.name),
  );
  const [servers, setServers] = useState(() => found.servers.map((c) => c.url));
  const flip = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const run = useMutation({
    mutationFn: () => api.runSetupImport({ skills, servers }),
    onSuccess: (r) => {
      toast.success(t('skills.broughtIn', { skills: r.skills, servers: r.servers }));
      void qc.invalidateQueries({ queryKey: ['skills'] });
      void qc.invalidateQueries({ queryKey: ['connections'] });
      void qc.invalidateQueries({ queryKey: ['setup-import'] });
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto rounded-3xl sm:max-w-xl">
        <DialogTitle>{t('skills.bringIn')}</DialogTitle>
        <DialogDescription>{t('skills.bringInHint')}</DialogDescription>
        <div className="space-y-4">
          {found.skills.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-sm font-medium">{t('skills.bringInSkills')}</h3>
              {found.skills.map((k) => (
                <label key={k.name} className="flex items-start gap-3 rounded-xl border px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={skills.includes(k.name)}
                    onChange={() => setSkills((l) => flip(l, k.name))}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{k.name}</span>{' '}
                    <span className="text-muted-foreground">· {k.source}</span>
                    <span className="block text-muted-foreground">{k.description}</span>
                    {k.warnings.map((w) => (
                      <span key={w} className="mt-1 flex gap-1 text-amber-600 dark:text-amber-400">
                        <ShieldAlert className="mt-0.5 size-3.5 shrink-0" /> {t(`skills.warn.${w}`)}
                      </span>
                    ))}
                  </span>
                </label>
              ))}
            </section>
          )}
          {found.servers.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-sm font-medium">{t('skills.bringInServers')}</h3>
              {found.servers.map((c) => (
                <label key={c.url} className="flex items-start gap-3 rounded-xl border px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={servers.includes(c.url)}
                    onChange={() => setServers((l) => flip(l, c.url))}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{c.name}</span>{' '}
                    <span className="text-muted-foreground">· {c.source}</span>
                    <span className="block font-mono text-xs break-all text-muted-foreground">{c.url}</span>
                  </span>
                </label>
              ))}
            </section>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" className="rounded-full" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              className="rounded-full"
              disabled={run.isPending || (!skills.length && !servers.length)}
              onClick={() => run.mutate()}
            >
              {t('skills.bringInRun')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
