import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { useT } from '@/i18n';
import { api } from '@/lib/api';

/**
 * Sealing content at rest: conversation text, prompts, memory and mail are stored encrypted, so a
 * copy of the database alone does not reveal them. The key stays in the data folder.
 */
export function ContentSeal() {
  const t = useT();
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['content-encryption'],
    queryFn: api.contentEncryption,
    refetchInterval: (q) => (q.state.data?.converting ? 1500 : false),
  });
  const set = useMutation({
    mutationFn: (on: boolean) => api.setContentEncryption(on),
    onSuccess: (s) => qc.setQueryData(['content-encryption'], s),
    onError: (e) => toast.error((e as Error).message),
  });
  if (!data) return null;
  return (
    <section className="space-y-2">
      <label className="flex items-center gap-3 rounded-2xl border bg-card/50 px-4 py-3">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{t('seal.title')}</span>
          <span className="block text-xs text-muted-foreground">{t('seal.hint')}</span>
          {(data.converting || data.pending > 0) && (
            <span className="mt-1 block text-xs text-muted-foreground">
              {t(data.on ? 'seal.sealing' : 'seal.opening', { count: data.pending })}
            </span>
          )}
        </span>
        <Switch checked={data.on} disabled={set.isPending} onCheckedChange={(on) => set.mutate(on)} />
      </label>
    </section>
  );
}
