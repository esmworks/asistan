import type { Memory } from '@yumakbot/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { toast, toastError } from '@/components/overlay';
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
  const user = memory.filter((m) => m.scope === 'user');
  const botMem = memory.filter((m) => m.scope === 'bot');
  const botName = (id: string | null) => bots.find((b) => b.id === id)?.name ?? t('common.bot');
  const label = (m: Memory) => (m.site ? `${m.site} · ${m.content}` : m.content);
  const trash = (m: Memory) => (
    <IconButton icon="trash-2" size={18} label={t('common.delete')} onPress={() => forget.mutate(m)} />
  );
  return (
    <>
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
});
