import Feather from '@expo/vector-icons/Feather';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Children, useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Row, Sheet, type IconName } from '@/components/page';
import { toastError } from '@/components/overlay';
import { Field } from '@/components/ui';
import { useApi, useServer } from '@/lib/server';
import type { Settings } from '@/lib/api';
import { useColors } from '@/lib/theme';

/**
 * Small pieces the settings sections share. Sections sit inside `Section` (a card); these fill it:
 * `Rows` for lines with dividers, `Pad` for free-form content, `Chip` and `ChoiceRow` for choices,
 * `SavedField` for a text saved when it loses focus, `Status` for a ok/problem label and
 * `useSaveSettings` for changing the server's settings.
 */

/** Rows of a card with a hairline between them; empty children are skipped. */
export function Rows({ children }: { children: ReactNode }) {
  const c = useColors();
  const items = Children.toArray(children).filter(Boolean);
  return (
    <>
      {items.map((item, i) => (
        <View
          key={i}
          style={i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderColor: c.border } : undefined}
        >
          {item}
        </View>
      ))}
    </>
  );
}

/** Free-form content inside a card, with the card's usual padding. */
export function Pad({ children, gap = 12 }: { children: ReactNode; gap?: number }) {
  return <View style={{ padding: 16, gap }}>{children}</View>;
}

/** A line of small muted text, for hints inside a card. */
export function Hint({ children }: { children: ReactNode }) {
  const c = useColors();
  return <Text style={[styles.hint, { color: c.mutedForeground }]}>{children}</Text>;
}

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
  icon?: IconName;
}) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        { borderColor: on ? c.brand : c.border, backgroundColor: on ? `${c.brand}1A` : 'transparent' },
        pressed && { opacity: 0.7 },
      ]}
    >
      {check ? (
        <View
          style={[
            styles.tick,
            { borderColor: on ? c.brand : c.border, backgroundColor: on ? c.brand : 'transparent' },
          ]}
        >
          {on ? <Feather name="check" size={11} color="#FFFFFF" /> : null}
        </View>
      ) : null}
      {icon ? <Feather name={icon} size={14} color={c.foreground} /> : null}
      <Text style={[styles.chipText, { color: c.foreground }]}>{label}</Text>
    </Pressable>
  );
}

/** Chips that wrap onto more lines. */
export function ChipRow({ children }: { children: ReactNode }) {
  return <View style={styles.chips}>{children}</View>;
}

/** A card holding one choice among `options`, picked from a sheet that slides up. */
export function ChoiceRow<V extends string>({
  icon,
  label,
  detail,
  value,
  options,
  onChange,
  placeholder,
  disabled,
}: {
  icon?: IconName;
  label: string;
  detail?: string | null;
  value: V | '';
  options: { value: V; label: string }[];
  onChange: (v: V) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value)?.label ?? placeholder ?? '';
  return (
    <>
      <Row
        icon={icon}
        label={label}
        detail={detail}
        value={current}
        disabled={disabled}
        onPress={() => setOpen(true)}
      />
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={label}
        items={options.map((o) => ({
          label: o.label,
          selected: o.value === value,
          onPress: () => onChange(o.value),
        }))}
      />
    </>
  );
}

/** A label with an optional check or cross, for states such as signed in or not found. */
export function Status({ state, label }: { state: 'ok' | 'problem' | 'unknown'; label: string }) {
  const c = useColors();
  const color = state === 'ok' ? c.success : state === 'problem' ? c.amber : c.mutedForeground;
  return (
    <View style={styles.status}>
      {state !== 'unknown' ? <Feather name={state === 'ok' ? 'check' : 'x'} size={16} color={color} /> : null}
      <Text style={[styles.statusText, { color }]}>{label}</Text>
    </View>
  );
}

/**
 * A text saved when it loses focus, shown under its label and an optional hint; a
 * change that is not saved yet stays in the box.
 */
export function SavedField({
  label,
  hint,
  value,
  max,
  placeholder,
  multiline,
  bare,
  onSave,
}: {
  label: string;
  /** The section title already says what the box is for, so the label is only read aloud. */
  bare?: boolean;
  hint?: string;
  value: string;
  max: number;
  placeholder?: string;
  multiline?: boolean;
  onSave: (v: string) => void;
}) {
  const c = useColors();
  const [draft, setDraft] = useState<string | null>(null);
  // Leaving the screen with the keyboard still up may not send a blur; save what was typed then.
  const pending = useRef({ draft, value, onSave });
  useEffect(() => {
    pending.current = { draft, value, onSave };
  });
  useEffect(
    () => () => {
      const p = pending.current;
      if (p.draft !== null && p.draft.trim() !== p.value) p.onSave(p.draft.trim());
    },
    [],
  );
  return (
    <View style={styles.saved}>
      {bare ? null : (
        <View>
          <Text style={[styles.savedLabel, { color: c.foreground }]}>{label}</Text>
          {hint ? <Text style={[styles.hint, { color: c.mutedForeground }]}>{hint}</Text> : null}
        </View>
      )}
      <Field
        value={draft ?? value}
        maxLength={max}
        placeholder={placeholder}
        accessibilityLabel={label}
        multiline={multiline}
        onChangeText={setDraft}
        onBlur={() => {
          if (draft !== null && draft.trim() !== value) onSave(draft.trim());
          setDraft(null);
        }}
        style={multiline ? styles.area : undefined}
      />
    </View>
  );
}

/** Changes the server's settings and refreshes them; a failure shows as a note. */
export function useSaveSettings() {
  const api = useApi();
  const { origin } = useServer();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<Settings>) => api.updateSettings(patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings', origin] }),
    onError: toastError,
  });
}

const styles = StyleSheet.create({
  hint: { fontSize: 13, lineHeight: 18 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 6,
    minHeight: 36,
    maxWidth: '100%',
  },
  // A long label wraps inside the chip instead of running past the card.
  chipText: { fontSize: 14, flexShrink: 1, textAlign: 'center' },
  tick: {
    width: 16,
    height: 16,
    borderRadius: 5,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  status: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  statusText: { fontSize: 14 },
  saved: { gap: 6 },
  savedLabel: { fontSize: 15 },
  area: { height: undefined, minHeight: 110, borderRadius: 16, paddingTop: 12, textAlignVertical: 'top' },
});
