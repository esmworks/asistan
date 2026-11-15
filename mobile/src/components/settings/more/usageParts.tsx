import type { UsageReport } from '@yumakbot/shared';
import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { Section } from '@/components/page';
import { Rows } from '../common/controls';
import { calendarDay, usd } from './money';
import { t } from '@/i18n';
import { useColors } from '@/lib/theme';

/** A thin bar showing `share` (0 to 1) of the whole. */
export function ShareBar({ share, color }: { share: number; color?: string }) {
  const c = useColors();
  return (
    <View style={[styles.track, { backgroundColor: c.muted }]}>
      <View
        style={[
          styles.fill,
          { width: `${Math.min(1, Math.max(0, share)) * 100}%`, backgroundColor: color ?? c.primary },
        ]}
      />
    </View>
  );
}

/** One line of a usage list: a name, its turns and cost, and its share of the total as a bar. */
export function UsageLine({
  lead,
  name,
  note,
  turns,
  cost,
  share,
  onPress,
}: {
  lead?: ReactNode;
  name: string;
  note?: string | null;
  turns: number;
  cost: number;
  share: number;
  onPress?: () => void;
}) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [styles.line, pressed && { backgroundColor: c.accent }]}
    >
      {lead}
      <View style={styles.lineText}>
        <View style={styles.nameRow}>
          <Text style={[styles.name, { color: c.foreground }]} numberOfLines={1}>
            {name}
          </Text>
          {note ? (
            <Text style={[styles.note, { color: c.mutedForeground }]} numberOfLines={1}>
              {note}
            </Text>
          ) : null}
        </View>
        <ShareBar share={share} />
        <Text style={[styles.note, { color: c.mutedForeground }]}>
          {t('usage.turnCount', { count: turns })}
        </Text>
      </View>
      <Text style={[styles.cost, { color: c.foreground }]}>{usd(cost)}</Text>
    </Pressable>
  );
}

/** A usage list on its own card; `empty` shows when there is nothing in it. */
export function UsageCard({
  title,
  empty,
  children,
}: {
  title: string;
  empty: boolean;
  children: ReactNode;
}) {
  const c = useColors();
  return (
    <Section title={title}>
      {empty ? (
        <Text style={[styles.empty, { color: c.mutedForeground }]}>{t('usage.empty')}</Text>
      ) : (
        <Rows>{children}</Rows>
      )}
    </Section>
  );
}

export function BotMark({ name, color, avatar }: { name: string; color?: string; avatar?: string }) {
  const c = useColors();
  return <Avatar name={name} color={color ?? c.muted} avatar={avatar} size={28} />;
}

/** One bar per day, the highest at the top of the plot; touching a day shows its numbers. */
export function DailyChart({ daily }: { daily: UsageReport['daily'] }) {
  const c = useColors();
  const [pick, setPick] = useState<number | null>(null);
  const max = Math.max(0, ...daily.map((d) => d.costUsd));
  const first = daily[0];
  const last = daily.at(-1);
  if (!first || !last) return null;
  const tip = pick === null ? null : daily[pick];
  return (
    <View
      accessible
      accessibilityLabel={t('usage.chart', { from: calendarDay(first.date), to: calendarDay(last.date) })}
    >
      <Text style={[styles.note, { color: c.mutedForeground }]}>{usd(max)}</Text>
      <View style={[styles.plot, { borderColor: c.border }]}>
        {daily.map((d, i) => (
          // The whole column is the touch target, not only the bar.
          <Pressable
            key={d.date}
            onPress={() => setPick((p) => (p === i ? null : i))}
            style={[styles.column, pick === i && { backgroundColor: c.accent }]}
          >
            {d.costUsd > 0 ? (
              <View
                style={[
                  styles.bar,
                  { backgroundColor: c.primary, height: `${Math.max(2, (d.costUsd / max) * 100)}%` },
                ]}
              />
            ) : null}
          </Pressable>
        ))}
      </View>
      <View style={styles.axis}>
        <Text style={[styles.note, { color: c.mutedForeground }]}>{calendarDay(first.date, true)}</Text>
        <Text style={[styles.note, { color: c.mutedForeground }]}>{calendarDay(last.date, true)}</Text>
      </View>
      <Text style={[styles.tip, { color: c.foreground }]}>
        {tip
          ? `${calendarDay(tip.date)} · ${usd(tip.costUsd)} · ${t('usage.turnCount', { count: tip.turns })}`
          : ' '}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  track: { height: 4, borderRadius: 2, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 2 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  lineText: { flex: 1, gap: 5 },
  nameRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  name: { flexShrink: 1, fontSize: 17 },
  note: { fontSize: 13, lineHeight: 17 },
  cost: { fontSize: 17, fontWeight: '500', fontVariant: ['tabular-nums'] },
  empty: { fontSize: 16, padding: 16 },
  plot: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 1,
    height: 144,
    marginTop: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  column: {
    flex: 1,
    height: '100%',
    justifyContent: 'flex-end',
    borderTopLeftRadius: 3,
    borderTopRightRadius: 3,
  },
  bar: { width: '100%', borderTopLeftRadius: 3, borderTopRightRadius: 3 },
  axis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  tip: { fontSize: 15, marginTop: 8, fontVariant: ['tabular-nums'] },
});
