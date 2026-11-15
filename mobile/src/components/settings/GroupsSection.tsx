import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { confirm, toastError } from '@/components/overlay';
import { IconButton, PillButton, Row, Section } from '@/components/page';
import { Field } from '@/components/ui';
import { Hint, Pad, Rows } from './common/controls';
import { locale, t } from '@/i18n';
import { formatters } from '@/lib/format';
import { useBots, useGroups } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';

const fmt = formatters(locale, t);

/** The "groups" settings section's content: groups, then the bots put away from the list. */
export function GroupsSection() {
  const api = useApi();
  const { origin } = useServer();
  const { data: groups = [] } = useGroups();
  const { data: bots = [] } = useBots();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['groups', origin] });
  const add = useMutation({
    mutationFn: () => api.createGroup(name),
    onSuccess: () => {
      setName('');
      void refresh();
    },
    onError: toastError,
  });
  const remove = useMutation({
    mutationFn: api.deleteGroup,
    onSuccess: () => {
      void refresh();
      void qc.invalidateQueries({ queryKey: ['bots', origin] });
    },
    onError: toastError,
  });
  return (
    <>
      <View style={styles.form}>
        <Field
          value={name}
          onChangeText={setName}
          placeholder={t('groups.placeholder')}
          accessibilityLabel={t('groups.placeholder')}
          style={styles.grow}
          returnKeyType="done"
          onSubmitEditing={() => name.trim() && add.mutate()}
        />
        <PillButton
          variant="primary"
          size="large"
          label={t('common.add')}
          onPress={() => add.mutate()}
          busy={add.isPending}
          disabled={!name.trim()}
        />
      </View>
      <Section footer={t('groups.hint')}>
        <Rows>
          {groups.length === 0 ? (
            <Pad>
              <Hint>{t('groups.empty')}</Hint>
            </Pad>
          ) : null}
          {groups.map((g) => {
            const count = bots.filter((b) => b.groupId === g.id).length;
            return (
              <Row
                key={g.id}
                label={g.name}
                detail={t('groups.count', { count })}
                right={
                  <IconButton
                    icon="trash-2"
                    size={18}
                    label={t('common.delete')}
                    onPress={async () => {
                      if (
                        count === 0 ||
                        (await confirm({
                          title: t('sidebarMenu.deleteGroupConfirm', { name: g.name }),
                          destructive: true,
                          confirmLabel: t('common.delete'),
                        }))
                      )
                        remove.mutate(g.id);
                    }}
                  />
                }
              />
            );
          })}
        </Rows>
      </Section>
      <ArchivedBots />
    </>
  );
}

/** Bots put away from the list: each can come back, or go for good with all it holds. */
function ArchivedBots() {
  const api = useApi();
  const { origin } = useServer();
  const c = useColors();
  const qc = useQueryClient();
  const { data: archived = [] } = useQuery({
    queryKey: ['bots', origin, 'archived'],
    queryFn: api.archivedBots,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['bots', origin] });
  const restore = useMutation({ mutationFn: api.restoreBot, onSuccess: refresh, onError: toastError });
  const remove = useMutation({ mutationFn: api.deleteBot, onSuccess: refresh, onError: toastError });
  return (
    <Section title={t('archive.title')}>
      <Rows>
        {archived.length === 0 ? (
          <Pad>
            <Hint>{t('archive.empty')}</Hint>
          </Pad>
        ) : null}
        {archived.map((b) => (
          <Row
            key={b.id}
            label={b.name}
            detail={b.archivedAt ? t('archive.since', { when: fmt.dayLabel(b.archivedAt) }) : null}
            right={
              <View style={styles.actions}>
                <PillButton
                  label={t('archive.restore')}
                  onPress={() => restore.mutate(b.id)}
                  disabled={restore.isPending}
                />
                <IconButton
                  icon="trash-2"
                  size={18}
                  color={c.destructive}
                  label={t('archive.delete')}
                  disabled={remove.isPending}
                  onPress={async () => {
                    if (
                      await confirm({
                        title: t('archive.deleteConfirm', { name: b.name }),
                        destructive: true,
                        confirmLabel: t('archive.delete'),
                      })
                    )
                      remove.mutate(b.id);
                  }}
                />
              </View>
            }
          />
        ))}
      </Rows>
    </Section>
  );
}

const styles = StyleSheet.create({
  // The box and its button share a row, as on the web.
  form: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  grow: { flex: 1 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
});
