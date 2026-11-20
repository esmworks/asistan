import type { Skill } from '@leafbot/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Feather from '@expo/vector-icons/Feather';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { toastError } from '@/components/overlay';
import { LabeledInput, PillButton } from '@/components/page';
import { BotSwitches } from './BotSwitches';
import { skillWarnings } from './skillText';
import { t } from '@/i18n';
import { useBots } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';

export interface SkillDraft {
  name: string;
  description: string;
  body: string;
}

/** Writes or edits one skill, and picks the bots that have it. */
export function SkillForm({
  skill,
  draft,
  onClose,
}: {
  skill: Skill | null;
  draft: SkillDraft | null;
  onClose: () => void;
}) {
  const api = useApi();
  const { origin } = useServer();
  const qc = useQueryClient();
  const c = useColors();
  const { data: bots = [] } = useBots();
  const start = skill ?? draft;
  const [name, setName] = useState(start?.name ?? '');
  const [description, setDescription] = useState(start?.description ?? '');
  const [body, setBody] = useState(start?.body ?? '');
  const [botIds, setBotIds] = useState<string[]>(skill?.botIds ?? []);
  const save = useMutation({
    mutationFn: async () => {
      const fields = { name: name.trim(), description: description.trim(), body };
      if (!skill) return api.createSkill({ ...fields, botIds });
      const saved = await api.updateSkill(skill.id, fields);
      for (const b of bots) {
        const on = botIds.includes(b.id);
        if (on !== skill.botIds.includes(b.id)) await api.setSkillBot(skill.id, b.id, on);
      }
      return saved;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['skills', origin] });
      onClose();
    },
    onError: toastError,
  });
  const ready = !!name.trim() && !!description.trim() && !save.isPending;
  // What the skill's text may hide; read before the skill goes to any bot.
  const warnings = skillWarnings(`${name}\n${description}\n${body}`);
  return (
    <View style={styles.form}>
      <Text style={[styles.title, { color: c.foreground }]}>
        {skill ? t('skills.edit') : t('skills.new')}
      </Text>
      <Text style={[styles.hint, { color: c.mutedForeground }]}>{t('skills.dialogHint')}</Text>
      <LabeledInput
        label={t('skills.name')}
        value={name}
        onChangeText={(v) => setName(v.toLowerCase().replace(/\s+/g, '-'))}
        placeholder={t('skills.namePlaceholder')}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
      />
      <LabeledInput
        label={t('skills.description')}
        value={description}
        onChangeText={setDescription}
        placeholder={t('skills.descriptionPlaceholder')}
      />
      <LabeledInput
        label={t('skills.body')}
        value={body}
        onChangeText={setBody}
        placeholder={t('skills.bodyPlaceholder')}
        multiline
        autoCapitalize="none"
        style={styles.mono}
      />
      {warnings.length > 0 ? (
        <View
          accessibilityRole="alert"
          style={[styles.warn, { borderColor: c.amber, backgroundColor: c.amberSoft }]}
        >
          <Feather name="alert-triangle" size={20} color={c.amber} />
          <View style={styles.warnText}>
            {warnings.map((w) => (
              <Text key={w} style={[styles.warnLine, { color: c.foreground }]}>
                {t(`skills.warn.${w}`)}
              </Text>
            ))}
          </View>
        </View>
      ) : null}
      {bots.length > 0 ? (
        <View style={styles.bots}>
          <Text style={[styles.label, { color: c.foreground }]}>{t('skills.bots')}</Text>
          <BotSwitches
            bots={bots}
            on={(id) => botIds.includes(id)}
            onChange={(id, on) => setBotIds((ids) => (on ? [...ids, id] : ids.filter((x) => x !== id)))}
          />
        </View>
      ) : null}
      <View style={styles.buttons}>
        <PillButton variant="ghost" label={t('common.cancel')} onPress={onClose} />
        <PillButton
          variant="primary"
          label={t('common.save')}
          onPress={() => save.mutate()}
          busy={save.isPending}
          disabled={!ready}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: 14 },
  title: { fontSize: 17, fontWeight: '600' },
  hint: { fontSize: 15, lineHeight: 20 },
  mono: { fontFamily: 'Menlo', fontSize: 15, minHeight: 180 },
  warn: { flexDirection: 'row', gap: 8, borderWidth: 1, borderRadius: 14, padding: 12 },
  warnText: { flex: 1, gap: 4 },
  warnLine: { fontSize: 16, lineHeight: 21 },
  bots: { gap: 6 },
  label: { fontSize: 16, fontWeight: '500', paddingHorizontal: 4 },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
});
