import type { ReactNode } from 'react';
import { StyleSheet, Text, View, type TextInputProps } from 'react-native';
import { PillButton } from '@/components/page';
import { Field } from '@/components/ui';
import { t, type MessageKey } from '@/i18n';
import { useColors } from '@/lib/theme';

/** The save action every edit page carries in its header. */
export function SaveButton({ label, onPress, busy }: { label: string; onPress: () => void; busy?: boolean }) {
  return <PillButton label={label} onPress={onPress} busy={busy} variant="primary" />;
}

/** A label above a form control, with a validation message (a message key) under it. */
export function FormField({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: MessageKey;
  hint?: string;
  children: ReactNode;
}) {
  const c = useColors();
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: c.foreground }]}>{label}</Text>
      {children}
      {hint ? <Text style={[styles.hint, { color: c.mutedForeground }]}>{hint}</Text> : null}
      {error ? <Text style={[styles.hint, { color: c.destructive }]}>{t(error)}</Text> : null}
    </View>
  );
}

/** A single-line text box that marks itself invalid. */
export function TextBox({ invalid, ...rest }: TextInputProps & { invalid?: boolean }) {
  return (
    <Field invalid={invalid} accessibilityLabel={rest.accessibilityLabel ?? rest.placeholder} {...rest} />
  );
}

/** A multi-line text box. */
export function AreaBox({ invalid, ...rest }: TextInputProps & { invalid?: boolean }) {
  return <Field invalid={invalid} multiline style={styles.area} {...rest} />;
}

const styles = StyleSheet.create({
  field: { gap: 6 },
  label: { fontSize: 16, fontWeight: '500', paddingHorizontal: 4 },
  hint: { fontSize: 15, lineHeight: 20, paddingHorizontal: 4 },
  area: { height: undefined, minHeight: 110, borderRadius: 16, paddingTop: 12, textAlignVertical: 'top' },
});
