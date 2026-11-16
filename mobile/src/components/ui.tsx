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
import { SafeAreaView } from 'react-native-safe-area-context';
import { Avatar } from '@/components/Avatar';
import { CARD_AREA, CARD_FIELD, useInCard } from '@/components/card';
import { CONTROL_HEIGHT, useColors } from '@/lib/theme';

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

/** The app's mark: a disc in the brand color. */
/** The app's mascot: the brand-colored round bot with its eyes. */
export function Mark() {
  const c = useColors();
  return (
    <View style={styles.mark}>
      <Avatar name="" color={c.brand} avatar="shape:blob" size={64} motion="always" />
    </View>
  );
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
