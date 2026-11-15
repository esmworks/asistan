import Feather from '@expo/vector-icons/Feather';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/lib/theme';

/** A choice button; `check` shows a tick box for questions with several answers. */
export function Chip({
  on,
  check = false,
  onPress,
  label,
  icon,
}: {
  on: boolean;
  check?: boolean;
  onPress: () => void;
  label: string;
  icon?: ReactNode;
}) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      onPress={onPress}
      style={[
        styles.chip,
        { borderColor: on ? `${c.brand}99` : c.border, backgroundColor: on ? `${c.brand}1A` : 'transparent' },
      ]}
    >
      {check ? (
        <View
          style={[
            styles.box,
            on ? { borderColor: c.brand, backgroundColor: c.brand } : { borderColor: c.border },
          ]}
        >
          {on ? <Feather name="check" size={12} color="#FFFFFF" /> : null}
        </View>
      ) : null}
      {icon}
      <Text style={[styles.text, { color: c.foreground }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  box: {
    width: 16,
    height: 16,
    borderRadius: 5,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { fontSize: 17, flexShrink: 1 },
});
