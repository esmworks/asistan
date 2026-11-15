import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { toast, toastError } from '@/components/overlay';
import { PillButton } from '@/components/page';
import { Chip } from '../common/controls';
import { t } from '@/i18n';
import type { Api } from '@/lib/api';
import { useApi, useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';

/**
 * Picks what to bring in from the person's other AI tools. Skills whose text looks off start
 * unticked and say why; everything comes in switched off, for no bot until the person chooses.
 */
export function BringIn({
  found,
  onClose,
}: {
  found: Awaited<ReturnType<Api['setupImport']>>;
  onClose: () => void;
}) {
  const api = useApi();
  const { origin } = useServer();
  const qc = useQueryClient();
  const c = useColors();
  const [skills, setSkills] = useState(() =>
    found.skills.filter((k) => !k.warnings.length).map((k) => k.name),
  );
  const [servers, setServers] = useState(() => found.servers.map((s) => s.url));
  const flip = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const run = useMutation({
    mutationFn: () => api.runSetupImport({ skills, servers }),
    onSuccess: (r) => {
      toast(t('skills.broughtIn', { skills: r.skills, servers: r.servers }));
      for (const key of ['skills', 'connections', 'setup-import'])
        void qc.invalidateQueries({ queryKey: [key, origin] });
      onClose();
    },
    onError: toastError,
  });
  return (
    <View style={styles.box}>
      <Text style={[styles.title, { color: c.foreground }]}>{t('skills.bringIn')}</Text>
      <Text style={[styles.hint, { color: c.mutedForeground }]}>{t('skills.bringInHint')}</Text>
      {found.skills.length > 0 ? (
        <View style={styles.group}>
          <Text style={[styles.label, { color: c.foreground }]}>{t('skills.bringInSkills')}</Text>
          {found.skills.map((k) => (
            <View key={k.name} style={[styles.item, { borderColor: c.border }]}>
              <Chip
                check
                on={skills.includes(k.name)}
                onPress={() => setSkills((l) => flip(l, k.name))}
                label={`${k.name} · ${k.source}`}
              />
              <Text style={[styles.hint, { color: c.mutedForeground }]}>{k.description}</Text>
              {k.warnings.map((w) => (
                <Text key={w} style={[styles.hint, { color: c.amber }]}>
                  {t(`skills.warn.${w}`)}
                </Text>
              ))}
            </View>
          ))}
        </View>
      ) : null}
      {found.servers.length > 0 ? (
        <View style={styles.group}>
          <Text style={[styles.label, { color: c.foreground }]}>{t('skills.bringInServers')}</Text>
          {found.servers.map((s) => (
            <View key={s.url} style={[styles.item, { borderColor: c.border }]}>
              <Chip
                check
                on={servers.includes(s.url)}
                onPress={() => setServers((l) => flip(l, s.url))}
                label={`${s.name} · ${s.source}`}
              />
              <Text style={[styles.hint, { color: c.mutedForeground }]} selectable>
                {s.url}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      <View style={styles.buttons}>
        <PillButton variant="ghost" label={t('common.cancel')} onPress={onClose} />
        <PillButton
          variant="primary"
          label={t('skills.bringInRun')}
          onPress={() => run.mutate()}
          busy={run.isPending}
          disabled={!skills.length && !servers.length}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 14 },
  title: { fontSize: 17, fontWeight: '600' },
  hint: { fontSize: 15, lineHeight: 20 },
  group: { gap: 8 },
  label: { fontSize: 16, fontWeight: '500', paddingHorizontal: 4 },
  item: {
    gap: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    padding: 10,
    alignItems: 'flex-start',
  },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
});
