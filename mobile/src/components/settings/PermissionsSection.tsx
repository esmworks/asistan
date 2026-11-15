import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { toastError } from '@/components/overlay';
import { IconButton, PillButton, Row, Section, Segments } from '@/components/page';
import { Field } from '@/components/ui';
import { Hint, Pad, Rows } from './common/controls';
import { ruleLabel } from './common/text';
import { t, type MessageKey } from '@/i18n';
import { useConnections, useRules } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';

/** The "permissions" settings section's content, under the section's own title bar. */
export function PermissionsSection() {
  const api = useApi();
  const { origin } = useServer();
  const { data: rules = [] } = useRules();
  const { data: connections = [] } = useConnections();
  const apps = new Map(connections.map((c) => [c.slug, c.name]));
  const qc = useQueryClient();
  const [pattern, setPattern] = useState('');
  const [list, setList] = useState<'ask' | 'allow'>('ask');
  const add = useMutation({
    mutationFn: () => api.addRule({ list, pattern: pattern.trim() }),
    onSuccess: () => {
      setPattern('');
      void qc.invalidateQueries({ queryKey: ['rules', origin] });
    },
    onError: toastError,
  });
  const remove = useMutation({
    mutationFn: api.removeRule,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rules', origin] }),
    onError: toastError,
  });
  const group = (l: 'ask' | 'allow', title: MessageKey, hint: MessageKey) => (
    <Section title={t(title)}>
      <Rows>
        <Pad>
          <Hint>{t(hint)}</Hint>
        </Pad>
        {rules
          .filter((r) => r.list === l)
          .map((r) => {
            // The readable name on top, the rule as it is matched under it.
            const label = ruleLabel(r.pattern, t, apps);
            return (
              <Row
                key={r.id}
                label={label ?? r.pattern}
                detail={label ? r.pattern : undefined}
                right={
                  <IconButton
                    icon="trash-2"
                    size={18}
                    label={t('common.remove')}
                    onPress={() => remove.mutate(r.id)}
                  />
                }
              />
            );
          })}
      </Rows>
    </Section>
  );
  return (
    <>
      <View style={styles.form}>
        <Segments
          value={list}
          onChange={setList}
          options={[
            { value: 'ask', label: t('rules.ask') },
            { value: 'allow', label: t('rules.allow') },
          ]}
        />
        <View style={styles.addRow}>
          <Field
            value={pattern}
            onChangeText={setPattern}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={() => pattern.trim() && add.mutate()}
            placeholder={t('rules.placeholder')}
            accessibilityLabel={t('rules.placeholder')}
            style={styles.grow}
          />
          <PillButton
            variant="primary"
            label={t('common.add')}
            onPress={() => add.mutate()}
            busy={add.isPending}
            disabled={!pattern.trim()}
          />
        </View>
      </View>
      {group('ask', 'rules.ask', 'rules.askHint')}
      {group('allow', 'rules.allow', 'rules.allowHint')}
    </>
  );
}

const styles = StyleSheet.create({
  form: { gap: 10 },
  // The box and its button share a row, as on the web.
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  grow: { flex: 1 },
});
