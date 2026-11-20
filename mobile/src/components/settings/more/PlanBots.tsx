import type { BotImportPlan } from '@leafbot/shared';
import Feather from '@expo/vector-icons/Feather';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Section } from '@/components/page';
import { describeSchedule } from '@/components/panel/schedule';
import { Rows } from '../common/controls';
import { t } from '@/i18n';
import { useColors } from '@/lib/theme';

type PlanBot = BotImportPlan['bots'][number];

/** The bots an import file would add, each opening to what it holds. */
export function PlanBots({ plan }: { plan: BotImportPlan }) {
  return (
    <Section title={t('import.bots', { count: plan.bots.length })}>
      <Rows>
        {plan.bots.map((bot) => (
          <PlanBotRow key={bot.ref} bot={bot} />
        ))}
      </Rows>
    </Section>
  );
}

function PlanBotRow({ bot }: { bot: PlanBot }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  const skills = bot.skills ?? [];
  const summary = [
    bot.description,
    bot.name !== bot.nameInFile && t('import.renamed', { name: bot.nameInFile }),
    bot.group && t('import.inGroup', { group: bot.group }),
    t('import.counts', {
      routines: bot.routines.length,
      memories: bot.memories.length,
      skills: skills.length,
    }),
  ]
    .filter(Boolean)
    .join(' · ');
  const head = (text: string) => <Text style={[styles.head, { color: c.mutedForeground }]}>{text}</Text>;
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((v) => !v)}
        style={({ pressed }) => [styles.top, pressed && { backgroundColor: c.accent }]}
      >
        <View style={styles.topText}>
          <Text style={[styles.name, { color: c.foreground }]}>{bot.name}</Text>
          <Text style={[styles.small, { color: c.mutedForeground }]}>{summary}</Text>
        </View>
        <Feather name={open ? 'chevron-up' : 'chevron-down'} size={22} color={c.mutedForeground} />
      </Pressable>
      {open ? (
        <View style={styles.body}>
          <View style={styles.part}>
            {head(t('import.instructionsOf'))}
            <Text style={[styles.box, { backgroundColor: c.muted, color: c.foreground }]} selectable>
              {bot.instructions || t('import.none')}
            </Text>
          </View>
          {bot.routines.length > 0 ? (
            <View style={styles.part}>
              {head(t('import.routines'))}
              {bot.routines.map((r, i) => (
                <View key={i}>
                  <Text style={[styles.small, styles.strong, { color: c.foreground }]}>
                    {r.name} · {describeSchedule(r.schedule)}
                  </Text>
                  <Text style={[styles.small, { color: c.mutedForeground }]}>{r.prompt}</Text>
                </View>
              ))}
            </View>
          ) : null}
          {skills.length > 0 ? (
            <View style={styles.part}>
              {head(t('import.skills'))}
              {skills.map((k) => (
                <Text key={k.name} style={[styles.small, { color: c.mutedForeground }]}>
                  <Text style={[styles.strong, { color: c.foreground }]}>{k.name}</Text>
                  {' · '}
                  {k.existing ? t('import.skillExists') : k.description}
                </Text>
              ))}
            </View>
          ) : null}
          {bot.memories.length > 0 ? (
            <View style={styles.part}>
              {head(t('import.memories'))}
              {bot.memories.map((m, i) => (
                <Text key={i} style={[styles.small, { color: c.mutedForeground }]}>
                  {'• '}
                  {m}
                </Text>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  topText: { flex: 1, gap: 2 },
  name: { fontSize: 17, fontWeight: '500' },
  small: { fontSize: 15, lineHeight: 20 },
  strong: { fontWeight: '500' },
  body: { paddingHorizontal: 16, paddingBottom: 14, gap: 12 },
  part: { gap: 4 },
  head: { fontSize: 13, fontWeight: '500' },
  box: { borderRadius: 12, padding: 12, fontSize: 15, lineHeight: 20, overflow: 'hidden' },
});
