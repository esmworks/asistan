import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { toastError } from '@/components/overlay';
import { IconButton, PillButton, Row, Section, Segments, SwitchRow } from '@/components/page';
import { Field } from '@/components/ui';
import { ChoiceRow, Pad, Rows } from './common/controls';
import { ruleLabel } from './common/text';
import { t, type MessageKey } from '@/i18n';
import { useBots, useConnections, usePeople, useRules } from '@/lib/queries';
import { personNameOf } from '@/lib/today';
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
  // The bot a rule is for ('all': every bot), and whether its step needs a second person's yes.
  const [forBot, setForBot] = useState('all');
  const [second, setSecond] = useState(false);
  const [secondUser, setSecondUser] = useState('anyone');
  const { data: people = [] } = usePeople();
  // Offered only when at least one other person could give that yes.
  const { data: approvers = [] } = useQuery({
    queryKey: ['approvers', origin, forBot],
    queryFn: () => api.approvers(forBot === 'all' ? null : forBot),
    enabled: list === 'ask',
    retry: false,
  });
  const secondOffered = list === 'ask' && approvers.length >= 2;
  const needsSecond = secondOffered && second;
  const add = useMutation({
    mutationFn: () =>
      api.addRule({
        list,
        pattern: pattern.trim(),
        ...(forBot !== 'all' && { botId: forBot }),
        ...(needsSecond && {
          secondPerson: true,
          ...(secondUser !== 'anyone' && { secondUserId: secondUser }),
        }),
      }),
    onSuccess: () => {
      setPattern('');
      setSecond(false);
      setSecondUser('anyone');
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
            const bound =
              r.field && typeof r.limit === 'number'
                ? t(r.list === 'allow' ? 'rules.limitAllow' : 'rules.limitOver', {
                    field: r.field,
                    limit: String(r.limit),
                  })
                : '';
            const twoKeys = r.secondPerson
              ? r.secondUserId
                ? t('rules.secondNamed', {
                    name: personNameOf(people, r.secondUserId, t('people.owner'), t('common.someone')),
                  })
                : t('rules.secondOn')
              : '';
            const detail = [label ? r.pattern : '', bound, twoKeys, forBot].filter(Boolean).join(' · ');
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
        <Rows>
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
          </Pad>
          <ChoiceRow
            label={t('rules.forBotLabel')}
            value={forBot}
            options={[
              { value: 'all', label: t('rules.allBots') },
              ...bots.map((b) => ({ value: b.id, label: b.name })),
            ]}
            onChange={(v) => {
              setForBot(v);
              setSecondUser('anyone');
            }}
          />
          {secondOffered ? (
            <>
              <SwitchRow
                label={t('rules.second')}
                detail={t('rules.secondHint')}
                value={second}
                onChange={setSecond}
              />
              {second ? (
                <ChoiceRow
                  label={t('rules.secondWho')}
                  value={secondUser}
                  options={[
                    { value: 'anyone', label: t('rules.secondAnyone') },
                    ...approvers.map((p) => ({ value: p.id, label: p.name || t('people.owner') })),
                  ]}
                  onChange={setSecondUser}
                />
              ) : null}
            </>
          ) : null}
          <Pad>
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
        </Rows>
      </Section>
      {group('ask', 'rules.ask')}
      {group('allow', 'rules.allow')}
    </>
  );
}

const styles = StyleSheet.create({
  end: { flexDirection: 'row', justifyContent: 'flex-end' },
});
