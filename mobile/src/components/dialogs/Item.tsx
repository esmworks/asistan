import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useColors } from '@/lib/theme';

/** One tappable line of a list card: something on the left, text in the middle, a note at the end. */
export function Item({ onPress, children }: { onPress: () => void; children: ReactNode }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.item, pressed && { backgroundColor: c.accent }]}
    >
      {children}
    </Pressable>
  );
}

/** A flat card of items with a hairline between them. */
export function ItemCard({ children }: { children: ReactNode[] }) {
  const c = useColors();
  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
      {children.map((child, i) => (
        <View
          key={i}
          style={i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderColor: c.border } : undefined}
        >
          {child}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  card: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
});
