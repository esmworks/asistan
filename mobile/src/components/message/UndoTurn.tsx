import type { TurnChangeItem } from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { StyleSheet, Text, View } from 'react-native';
import { toast, toastError } from '@/components/overlay';
import { Loading, PillButton, Sheet } from '@/components/page';
import { t, type MessageKey } from '@/i18n';
import { restoredCount, undoGroups } from '@/lib/turns';
import { useServer, useApi } from '@/lib/server';
import { useColors } from '@/lib/theme';

/** One change, named by what it is and what taking the turn back does to it. */
function Line({ item, note }: { item: TurnChangeItem; note?: string }) {
  const c = useColors();
  return (
    <View style={styles.line}>
      <Text style={[styles.text, { color: c.foreground }]}>
        {t(`undo.kind.${item.kind}` as MessageKey)}: <Text style={styles.strong}>{item.label}</Text>
      </Text>
      <Text style={[styles.note, { color: c.mutedForeground }]}>
        {note ?? t(`undo.will.${item.op}` as MessageKey)}
      </Text>
    </View>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  const c = useColors();
  return (
    <View style={styles.group}>
      <Text style={[styles.groupTitle, { color: c.mutedForeground }]}>{title}</Text>
      {children}
    </View>
  );
}

/**
 * What taking a turn back would put back and, apart, what no one can: the steps that reached
 * outside and the changes too large to keep. Confirming puts things back newest first; whatever
 * changed again since is left as it is, and the conversation says so.
 */
export function UndoTurnSheet({
  turnId,
  threadId,
  open,
  onClose,
}: {
  turnId: string;
  threadId: string;
  open: boolean;
  onClose: () => void;
}) {
  const api = useApi();
  const { origin } = useServer();
  const qc = useQueryClient();
  const { data, isPending } = useQuery({
    queryKey: ['turn-changes', origin, threadId, turnId],
    queryFn: () => api.turnChanges(turnId),
    enabled: open,
  });
  const undo = useMutation({
    mutationFn: () => api.undoTurn(turnId),
    onSuccess: (res) => {
      toast(t('undo.done', { done: restoredCount(res.items), total: res.items.length }));
      onClose();
    },
    onError: toastError,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['messages', origin, threadId] });
      void qc.invalidateQueries({ queryKey: ['turn-changes', origin, threadId] });
    },
  });
  const items = data?.items ?? [];
  const { will, owner, kept } = undoGroups(items);
  const outside = data?.outside ?? [];
  const c = useColors();
  return (
    <Sheet open={open} onClose={onClose} title={t('undo.title')}>
      <View style={styles.body}>
        <Text style={[styles.note, { color: c.mutedForeground }]}>
          {data?.running ? t('undo.running') : data?.undone ? t('undo.already') : t('undo.intro')}
        </Text>
        {isPending ? <Loading /> : null}
        {will.length ? (
          <Group title={t('undo.willTitle')}>
            {will.map((i) => (
              <Line key={i.id} item={i} />
            ))}
          </Group>
        ) : null}
        {owner.length ? (
          <Group title={t('undo.ownerTitle')}>
            {owner.map((i) => (
              <Line key={i.id} item={i} note={t('undo.ownerNote')} />
            ))}
          </Group>
        ) : null}
        {kept.length || outside.length ? (
          <Group title={t('undo.cannotTitle')}>
            {kept.map((i) => (
              <Line key={i.id} item={i} note={t(i.reason === 'deleted' ? 'undo.deleted' : 'undo.tooBig')} />
            ))}
            {outside.map((o) => (
              <Text key={`${o.at}${o.summary}`} style={[styles.text, { color: c.foreground }]}>
                {o.summary}
              </Text>
            ))}
          </Group>
        ) : null}
        <View style={styles.buttons}>
          <PillButton label={t('common.cancel')} variant="ghost" onPress={onClose} />
          <PillButton
            label={t('undo.confirm')}
            variant="primary"
            busy={undo.isPending}
            disabled={isPending || !data || data.running || data.undone || !items.length}
            onPress={() => undo.mutate()}
          />
        </View>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 20, paddingVertical: 8, gap: 14 },
  group: { gap: 8 },
  groupTitle: { fontSize: 14, fontWeight: '600' },
  line: { gap: 1 },
  text: { fontSize: 16, lineHeight: 22 },
  strong: { fontWeight: '600' },
  note: { fontSize: 14, lineHeight: 20 },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
});
