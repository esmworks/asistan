import type { ClaudeModel, Effort } from '@yumakbot/shared';
import Feather from '@expo/vector-icons/Feather';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Chip, ChipRow } from '@/components/settings/common/controls';
import { t } from '@/i18n';
import { useClaudeModels } from '@/lib/queries';
import { useColors } from '@/lib/theme';

/**
 * Picks the default model and effort for Claude bots: the settings and the bot editor use it.
 *
 * Props:
 * - `value`: `{ model, effort }`; an empty model is the CLI's own default, an empty effort the model's.
 * - `onChange`: called with the whole new choice on every tap (the caller saves it).
 */

/** The CLI's own "default" row stands for "no model named"; it is offered as the empty choice. */
const CLI_DEFAULT = 'default';

export interface ModelChoice {
  model: string;
  effort: Effort | '';
}

/** The model a choice uses, from the list the server sent; undefined for the default. */
function find(models: ClaudeModel[], value: string) {
  return models.find((m) => m.value === (value || CLI_DEFAULT));
}

/** Effort levels the chosen model accepts; the default row's when no model is named. */
export function effortsFor(models: ClaudeModel[], model: string): Effort[] {
  return find(models, model)?.efforts ?? (model ? [] : (models[0]?.efforts ?? []));
}

export function ModelDefaults({
  value,
  onChange,
}: {
  value: ModelChoice;
  onChange: (v: ModelChoice) => void;
}) {
  const c = useColors();
  const { data: models = [], isLoading } = useClaudeModels();
  if (isLoading) return <ActivityIndicator color={c.mutedForeground} />;
  const named = models.filter((m) => m.value !== CLI_DEFAULT);
  const efforts = effortsFor(models, value.model);
  const pick = (model: string) => {
    const allowed = effortsFor(models, model);
    onChange({ model, effort: value.effort && allowed.includes(value.effort) ? value.effort : '' });
  };
  const rows: { value: string; name: string; description: string }[] = [
    { value: '', name: t('model.default'), description: t('model.defaultHint') },
    // Keep a model chosen earlier visible even if this login no longer lists it.
    ...(value.model && !find(models, value.model)
      ? [{ value: value.model, name: value.model, description: '' }]
      : []),
    ...named,
  ];
  return (
    <View style={styles.root}>
      <View style={styles.list} accessibilityRole="radiogroup" accessibilityLabel={t('model.defaultModel')}>
        {rows.map((m) => {
          const on = m.value === value.model;
          return (
            <Pressable
              key={m.value || CLI_DEFAULT}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              onPress={() => pick(m.value)}
              style={({ pressed }) => [
                styles.card,
                {
                  borderColor: on ? c.brand : c.outline,
                  backgroundColor: on ? `${c.brand}1A` : 'transparent',
                },
                pressed && { opacity: 0.7 },
              ]}
            >
              <View style={styles.cardText}>
                <Text style={[styles.name, { color: c.foreground }]}>{m.name}</Text>
                {m.description ? (
                  <Text style={[styles.description, { color: c.mutedForeground }]}>{m.description}</Text>
                ) : null}
              </View>
              {on ? <Feather name="check" size={20} color={c.brand} /> : null}
            </Pressable>
          );
        })}
      </View>
      <View style={styles.effort}>
        <View>
          <Text style={[styles.name, { color: c.foreground }]}>{t('model.effort')}</Text>
          <Text style={[styles.description, { color: c.mutedForeground }]}>
            {efforts.length ? t('model.effortHint') : t('model.noEffort')}
          </Text>
        </View>
        {efforts.length > 0 ? (
          <ChipRow>
            <Chip
              on={!value.effort}
              onPress={() => onChange({ ...value, effort: '' })}
              label={t('model.effortDefault')}
            />
            {efforts.map((e) => (
              <Chip
                key={e}
                on={value.effort === e}
                onPress={() => onChange({ ...value, effort: e })}
                label={t(`effort.${e}`)}
              />
            ))}
          </ChipRow>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 20 },
  list: { gap: 8 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  cardText: { flex: 1, gap: 2 },
  name: { fontSize: 17, fontWeight: '500' },
  description: { fontSize: 15, lineHeight: 20 },
  effort: { gap: 12 },
});
