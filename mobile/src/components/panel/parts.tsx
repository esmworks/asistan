import type { BrowserStatus } from '@leafbot/shared';
import Feather from '@expo/vector-icons/Feather';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import type { ReactNode } from 'react';
import { useInfo } from '@/lib/queries';
import { useColors } from '@/lib/theme';

/** A heading with an action at its right, above one block of the panel. */
export function SectionHead({
  title,
  action,
  plus,
  onAction,
  right,
}: {
  title: string;
  action?: string;
  /** Marks the action as adding something. */
  plus?: boolean;
  onAction?: () => void;
  right?: ReactNode;
}) {
  const c = useColors();
  return (
    <View style={styles.head}>
      <Text style={[styles.headTitle, { color: c.foreground }]} accessibilityRole="header">
        {title}
      </Text>
      {right}
      {action ? (
        <Pressable
          accessibilityRole="button"
          onPress={onAction}
          hitSlop={8}
          style={({ pressed }) => [styles.headButton, pressed && { opacity: 0.6 }]}
        >
          {plus ? <Feather name="plus" size={15} color={c.foreground} /> : null}
          <Text style={[styles.headAction, { color: c.foreground }]}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** A soft rounded block, pressable when given `onPress`. */
export function Block({
  children,
  onPress,
  style,
  label,
}: {
  children: ReactNode;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  label?: string;
}) {
  const c = useColors();
  const base = [styles.block, { backgroundColor: c.muted }, style];
  if (!onPress) return <View style={base}>{children}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [base, pressed && { backgroundColor: c.accent }]}
    >
      {children}
    </Pressable>
  );
}

export function StatusDot({ status }: { status: BrowserStatus }) {
  const c = useColors();
  const color =
    status === 'off'
      ? c.mutedForeground
      : status === 'idle'
        ? c.success
        : status === 'bot'
          ? c.brand
          : c.amber;
  return <View style={[styles.dot, { backgroundColor: color, opacity: status === 'off' ? 0.5 : 1 }]} />;
}

/** Whether the server gives bots a browser or a desktop; false until it has said. */
export function useBrowserAvailable(): boolean {
  const { data } = useInfo();
  return data?.computer.status === 'ok' || data?.browser.status === 'ok';
}

/** Bots have their own desktop (a computer service) rather than the server's shared browser. */
export function useDesktopAvailable(): boolean {
  const { data } = useInfo();
  return data?.computer.status === 'ok';
}

/** Width over height of the browser's and the desktop's picture. */
export const SCREEN_RATIO = 1280 / 800;

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8, minHeight: 28 },
  headTitle: { flex: 1, fontSize: 17, fontWeight: '600' },
  headButton: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  headAction: { fontSize: 16, fontWeight: '500' },
  block: { borderRadius: 16, paddingHorizontal: 14, paddingVertical: 12 },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
