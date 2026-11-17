import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { toastError } from '@/components/overlay';
import { IconButton, PillButton, Row, Section, Segments } from '@/components/page';
import { Field } from '@/components/ui';
import { Pad, Rows } from './common/controls';
import { ruleLabel } from './common/text';
import { t, type MessageKey } from '@/i18n';
import { useBots, useConnections, useRules } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';

/** The "permissions" settings section's content, under the section's own title bar. */
export function PermissionsSection() {
  const api = useApi();
  const { origin } = useServer();
  const { data: rules = [] } = useRules();
  const { data: connections = [] } = useConnections();
  const { data: bots = [] } = useBots();
  const apps = new Map(connections.map((c) => [c.slug, c.name]));
  const botNames = new Map(bots.map((b) => [b.id, b.name]));
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
  const group = (l: 'ask' | 'allow', title: MessageKey) => {
    const listed = rules.filter((r) => r.list === l);
    if (!listed.length) return null;
    return (
      <Section title={t(title)}>
        <Rows>
          {listed.map((r) => {
            // The readable name on top, the rule as it is matched under it, and the one bot it is for.
            const label = ruleLabel(r.pattern, t, apps);
            const forBot = r.botId ? t('rules.forBot', { bot: botNames.get(r.botId) ?? r.botId }) : '';
            const detail = [label ? r.pattern : '', forBot].filter(Boolean).join(' · ');
            return (
              <Row
                key={r.id}
                label={label ?? r.pattern}
                detail={detail || undefined}
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
  };
  return (
    <>
      <Section footer={t(list === 'ask' ? 'rules.askHint' : 'rules.allowHint')}>
        <Pad>
          <Segments
            value={list}
            onChange={setList}
            options={[
              { value: 'ask', label: t('rules.ask') },
              { value: 'allow', label: t('rules.allow') },
            ]}
          />
          <Field
            value={pattern}
            onChangeText={setPattern}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={() => pattern.trim() && add.mutate()}
            placeholder={t('rules.placeholder')}
            accessibilityLabel={t('rules.placeholder')}
          />
          <View style={styles.end}>
            <PillButton
              variant="primary"
              icon="plus"
              label={t('common.add')}
              onPress={() => add.mutate()}
              busy={add.isPending}
              disabled={!pattern.trim()}
            />
          </View>
        </Pad>
      </Section>
      {group('ask', 'rules.ask')}
      {group('allow', 'rules.allow')}
    </>
  );
}

const styles = StyleSheet.create({
  end: { flexDirection: 'row', justifyContent: 'flex-end' },
});
