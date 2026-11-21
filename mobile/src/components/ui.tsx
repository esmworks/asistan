import type { ComponentRef, ReactNode, Ref } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import { Image } from 'expo-image';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CARD_AREA, CARD_FIELD, useInCard } from '@/components/card';
import { CONTROL_HEIGHT, useColors } from '@/lib/theme';
import LOGO from '../../assets/logo.png';

/** A centered, keyboard-aware column for the connect and sign-in forms. */
export function FormScreen({ children }: { children: ReactNode }) {
  const c = useColors();
  return (
    <SafeAreaView style={[styles.fill, { backgroundColor: c.background }]}>
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.formContent} keyboardShouldPersistTaps="handled">
          <View style={styles.formColumn}>{children}</View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/**
 * Leaf Bot itself, drawn as its icon, as the web app's sign-in shows it: the round green bot on a dark
 * green tile. Its own colours rather than the brand colour, which is the interface's accent; and the
 * icon's picture rather than a live avatar, whose eyes sit in the middle of its body, outside the tile.
 */
export function Mark() {
  return <Image source={LOGO} style={[styles.mark, styles.logo]} accessible={false} />;
}

export function Title({ children }: { children: ReactNode }) {
  const c = useColors();
  return <Text style={[styles.title, { color: c.foreground }]}>{children}</Text>;
}

export function Hint({ children }: { children: ReactNode }) {
  const c = useColors();
  return <Text style={[styles.hint, { color: c.mutedForeground }]}>{children}</Text>;
}

export function ErrorText({ children }: { children: ReactNode }) {
  const c = useColors();
  return <Text style={[styles.error, { color: c.destructive }]}>{children}</Text>;
}

/** What a ref to a `Field` holds, for moving focus between fields. */
export type FieldHandle = ComponentRef<typeof TextInput>;

export function Field(props: TextInputProps & { invalid?: boolean; ref?: Ref<FieldHandle> }) {
  const c = useColors();
  const inCard = useInCard();
  const { invalid, style, ...rest } = props;
  return (
    <TextInput
      placeholderTextColor={c.mutedForeground}
      {...rest}
      style={[
        styles.field,
        { backgroundColor: c.card, color: c.foreground, borderColor: invalid ? c.destructive : c.border },
        inCard && [rest.multiline ? CARD_AREA : CARD_FIELD, { backgroundColor: c.muted }],
        style,
      ]}
    />
  );
}

export function Button({
  label,
  onPress,
  busy,
  variant = 'primary',
}: {
  label: string;
  onPress: () => void;
  busy?: boolean;
  variant?: 'primary' | 'ghost';
}) {
  const c = useColors();
  const primary = variant === 'primary';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ busy: !!busy, disabled: !!busy }}
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        primary ? { backgroundColor: c.primary } : null,
        { opacity: pressed || busy ? 0.7 : 1 },
      ]}
    >
      {busy ? <ActivityIndicator color={primary ? c.primaryForeground : c.foreground} /> : null}
      <Text
        style={[
          styles.buttonText,
          { color: primary ? c.primaryForeground : c.mutedForeground },
          primary ? null : styles.ghostText,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  formContent: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  formColumn: { width: '100%', maxWidth: 384, alignSelf: 'center', gap: 12 },
  mark: { alignSelf: 'center', marginBottom: 8 },
  // The rounding of the app's icon: about a fifth of its side.
  logo: { width: 64, height: 64, borderRadius: 14 },
  title: { fontSize: 26, fontWeight: '600', textAlign: 'center' },
  hint: { fontSize: 16, lineHeight: 22, textAlign: 'center', marginBottom: 4 },
  error: { fontSize: 16, paddingHorizontal: 16 },
  field: {
    height: CONTROL_HEIGHT,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 20,
    fontSize: 17,
  },
  button: {
    height: CONTROL_HEIGHT,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 20,
  },
  buttonText: { fontSize: 17, fontWeight: '600' },
  ghostText: { fontSize: 16, fontWeight: '500' },
});
