import { useMutation } from '@tanstack/react-query';
import Feather from '@expo/vector-icons/Feather';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { toastError } from '@/components/overlay';
import { PillButton } from '@/components/page';
import { useClaudeState } from '@/components/settings/connect/ClaudeConnect';
import { t } from '@/i18n';
import { useSettings } from '@/lib/queries';
import { useApi } from '@/lib/server';
import { useColors } from '@/lib/theme';
import { occupationText, type Answers } from './About';
import { newBotEngine, starterBot, suggestedStarters, type StarterId } from './profile';

/** The last step: saves the answers to the profile and sets up the starter bots chosen. */
export function BotsStep({
  answers,
  created,
  onBack,
  onDone,
}: {
  answers: Answers;
  /** Bots already made by an attempt that failed half way, so a retry does not make them again. */
  created: Map<StarterId, string>;
  onBack: () => void;
  onDone: () => void;
}) {
  const c = useColors();
  const api = useApi();
  const { data: settings } = useSettings();
  const { connected: claudeOk } = useClaudeState();
  const engine = newBotEngine(settings);
  const ready = engine.engine === 'pi' || claudeOk;
  const offered = suggestedStarters(answers.helpWith);
  const [chosen, setChosen] = useState<StarterId[]>(offered);
  const finish = useMutation({
    mutationFn: async () => {
      await api.updateSettings({
        userName: answers.name,
        addressAs: answers.addressAs,
        occupation: occupationText(answers),
        ...(answers.focus ? { focus: answers.focus } : {}),
        helpWith: answers.helpWith,
        aboutMe: answers.about,
      });
      for (const id of offered) {
        if (!chosen.includes(id) || created.has(id)) continue;
        created.set(id, (await api.createBot({ ...starterBot(id, t), ...engine })).id);
      }
      await api.updateSettings({ onboarded: true });
    },
    onSuccess: onDone,
    onError: toastError,
  });
  const toggle = (id: StarterId) =>
    setChosen((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  return (
    <View style={styles.fill}>
      <ScrollView style={styles.fill} contentContainerStyle={styles.content}>
        <Text style={[styles.title, { color: c.foreground }]} accessibilityRole="header">
          {t('onboarding.botsTitle')}
        </Text>
        <Text style={[styles.body, { color: c.mutedForeground }]}>{t('onboarding.botsBody')}</Text>
        {!ready ? (
          <View style={[styles.warn, { backgroundColor: c.amberSoft, borderColor: `${c.amber}4D` }]}>
            <Text style={[styles.warnText, { color: c.foreground }]}>{t('onboarding.noAi')}</Text>
          </View>
        ) : null}
        <View style={styles.cards}>
          {offered.map((id) => {
            const bot = starterBot(id, t);
            const on = chosen.includes(id);
            return (
              <Pressable
                key={id}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => toggle(id)}
                style={[
                  styles.card,
                  {
                    borderColor: on ? `${c.brand}99` : c.border,
                    backgroundColor: on ? `${c.brand}0D` : 'transparent',
                  },
                ]}
              >
                <Avatar name={bot.name} color={bot.color} avatar={bot.avatar} size={44} />
                <View style={styles.cardText}>
                  <Text style={[styles.cardName, { color: c.foreground }]}>{bot.name}</Text>
                  <Text style={[styles.cardHint, { color: c.mutedForeground }]}>{bot.description}</Text>
                </View>
                <View
                  style={[
                    styles.box,
                    on ? { borderColor: c.brand, backgroundColor: c.brand } : { borderColor: c.border },
                  ]}
                >
                  {on ? <Feather name="check" size={16} color="#FFFFFF" /> : null}
                </View>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
      <View style={[styles.footer, { borderColor: c.border }]}>
        <PillButton
          label={t('onboarding.back')}
          variant="ghost"
          disabled={finish.isPending}
          onPress={onBack}
        />
        <View style={styles.spacer} />
        <PillButton
          label={
            finish.isPending
              ? t('onboarding.creating')
              : chosen.length
                ? t('onboarding.create')
                : t('onboarding.startEmpty')
          }
          variant="primary"
          busy={finish.isPending}
          onPress={() => finish.mutate()}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { padding: 24, paddingBottom: 32 },
  title: { fontSize: 26, fontWeight: '600', letterSpacing: -0.4 },
  body: { fontSize: 16, lineHeight: 22, marginTop: 8 },
  warn: { marginTop: 16, borderWidth: 1, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 12 },
  warnText: { fontSize: 16, lineHeight: 22 },
  cards: { marginTop: 24, gap: 12 },
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
  },
  cardText: { flex: 1, gap: 2 },
  cardName: { fontSize: 17, fontWeight: '500' },
  cardHint: { fontSize: 16, lineHeight: 22 },
  box: {
    width: 22,
    height: 22,
    borderRadius: 7,
    borderWidth: 1,
    marginTop: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth * 2,
  },
  spacer: { flex: 1 },
});
