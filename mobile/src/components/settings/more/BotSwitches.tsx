import { Switch, Text, View, StyleSheet } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { Rows } from '../common/controls';
import { useColors } from '@/lib/theme';
import type { Bot } from '@yumakbot/shared';

/** One switch per bot, for choosing which bots have something. */
export function BotSwitches({
  bots,
  on,
  onChange,
}: {
  bots: Bot[];
  on: (id: string) => boolean;
  onChange: (id: string, on: boolean) => void;
}) {
  const c = useColors();
  return (
    <View style={[styles.box, { borderColor: c.border }]}>
      <Rows>
        {bots.map((b) => (
          <View key={b.id} style={styles.row}>
            <Avatar name={b.name} color={b.color} avatar={b.avatar} size={28} />
            <Text style={[styles.name, { color: c.foreground }]} numberOfLines={1}>
              {b.name}
            </Text>
            <Switch
              value={on(b.id)}
              onValueChange={(v) => onChange(b.id, v)}
              trackColor={{ true: c.primary, false: c.muted }}
              thumbColor={on(b.id) ? c.primaryForeground : undefined}
              accessibilityLabel={b.name}
            />
          </View>
        ))}
      </Rows>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 8 },
  name: { flex: 1, fontSize: 15 },
});
