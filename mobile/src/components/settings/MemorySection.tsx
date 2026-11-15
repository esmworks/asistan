import type { Memory } from '@yumakbot/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { confirm, toast, toastError } from '@/components/overlay';
import { IconButton, PillButton, Row, Section } from '@/components/page';
import { Field } from '@/components/ui';
import { Hint, Pad, Rows } from './common/controls';
import { t } from '@/i18n';
import { useBots, useMemory } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';

/** The "memory" settings section's content, under the section's own title bar. */
export function MemorySection() {
  const api = useApi();
  const { origin } = useServer();
  const { data: memory = [] } = useMemory();
  const { data: bots = [] } = useBots();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['memory', origin] });
  const add = useMutation({
    mutationFn: () => api.addMemory({ scope: 'user', content: text }),
    onSuccess: () => {
      setText('');
      void refresh();
    },
    onError: toastError,
  });
  const approve = useMutation({
    mutationFn: (id: string) => api.updateMemory(id, { status: 'active' }),
    onSuccess: refresh,
    onError: toastError,
  });
  const remove = useMutation({
    mutationFn: api.removeMemory,
    onSuccess: refresh,
    onError: toastError,
  });
  const settle = useMutation({
    mutationFn: api.settleProposedMemory,
    onSuccess: refresh,
    onError: toastError,
  });
  // A deleted memory can be brought back for a moment, in case the wrong one went.
  const forget = useMutation({
    mutationFn: async (m: Memory) => {
      await api.removeMemory(m.id);
      return m;
    },
    onSuccess: (m) => {
      void refresh();
      toast(t('memory.deleted'), {
        action: {
          label: t('memory.undo'),
          onPress: () =>
            void api
              .addMemory({ scope: m.scope, botId: m.botId, content: m.content, site: m.site })
              .then(refresh)
              .catch(toastError),
        },
      });
    },
    onError: toastError,
  });
  const proposed = memory.filter((m) => m.status === 'proposed');
  const user = memory.filter((m) => m.scope === 'user' && m.status === 'active');
  // Proposals are listed once, above; the bots' notes are the ones in use.
  const botMem = memory.filter((m) => m.scope === 'bot' && m.status === 'active');
  const botName = (id: string | null) => bots.find((b) => b.id === id)?.name ?? t('common.bot');
  const label = (m: Memory) => (m.site ? `${m.site} · ${m.content}` : m.content);
  const trash = (m: Memory) => (
    <IconButton icon="trash-2" size={18} label={t('common.delete')} onPress={() => forget.mutate(m)} />
  );
  return (
    <>
      {proposed.length > 0 ? (
        <Section title={t('memory.proposed')}>
          <Rows>
            {proposed.length > 1 ? (
              <Row
                label={t('memory.proposedCount', { count: proposed.length })}
                right={
                  <View style={styles.actions}>
                    <PillButton
                      label={t('memory.approveAll')}
                      variant="primary"
                      disabled={settle.isPending}
                      onPress={() => settle.mutate('approve')}
                    />
                    <PillButton
                      label={t('memory.deleteAll')}
                      disabled={settle.isPending}
                      onPress={async () => {
                        if (
                          await confirm({
                            title: t('memory.deleteAllConfirm', { count: proposed.length }),
                            destructive: true,
                            confirmLabel: t('common.delete'),
                          })
                        )
                          settle.mutate('delete');
                      }}
                    />
                  </View>
                }
              />
            ) : null}
            {proposed.map((m) => (
              <Row
                key={m.id}
                label={label(m)}
                detail={
                  m.source === 'import'
                    ? t('memory.fromImport', { name: botName(m.botId) })
                    : t('memory.proposedBy', { name: botName(m.source.replace('bot:', '')) })
                }
                right={
                  <View style={styles.actions}>
                    <PillButton
                      label={t('memory.approve')}
                      variant="primary"
                      onPress={() => approve.mutate(m.id)}
                    />
                    <IconButton
                      icon="trash-2"
                      size={18}
                      label={t('common.delete')}
                      onPress={() => remove.mutate(m.id)}
                    />
                  </View>
                }
              />
            ))}
          </Rows>
        </Section>
      ) : null}
      <View style={styles.form}>
        <Field
          value={text}
          onChangeText={setText}
          placeholder={t('memory.placeholder')}
          accessibilityLabel={t('memory.placeholder')}
          style={styles.grow}
          maxLength={2000}
          returnKeyType="done"
          onSubmitEditing={() => text.trim() && add.mutate()}
        />
        <PillButton
          variant="primary"
          size="large"
          label={t('common.add')}
          onPress={() => add.mutate()}
          busy={add.isPending}
          disabled={!text.trim()}
        />
      </View>
      <Section title={t('memory.user')}>
        <Rows>
          {user.length === 0 ? (
            <Pad>
              <Hint>{t('memory.empty')}</Hint>
            </Pad>
          ) : null}
          {user.map((m) => (
            <Row key={m.id} label={label(m)} right={trash(m)} />
          ))}
        </Rows>
      </Section>
      <Section title={t('memory.bots')}>
        <Rows>
          {botMem.length === 0 ? (
            <Pad>
              <Hint>{t('memory.empty')}</Hint>
            </Pad>
          ) : null}
          {botMem.map((m) => (
            <Row key={m.id} label={label(m)} detail={botName(m.botId)} right={trash(m)} />
          ))}
        </Rows>
      </Section>
    </>
  );
}

const styles = StyleSheet.create({
  // The box and its button share a row, as on the web.
  form: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  grow: { flex: 1 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
});
