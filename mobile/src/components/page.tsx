import Feather from '@expo/vector-icons/Feather';
import { router } from 'expo-router';
import {
  createContext,
  useContext,
  useMemo,
  useRef,
  type ComponentProps,
  type ComponentRef,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { t } from '@/i18n';
import { useColors } from '@/lib/theme';

export type IconName = ComponentProps<typeof Feather>['name'];

/** A round icon button, as the web app's header buttons are. */
export function IconButton({
  icon,
  label,
  onPress,
  disabled,
  size = 22,
  color,
  filled,
  children,
}: {
  icon?: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  size?: number;
  color?: string;
  /** On a muted round background, for the buttons a screen leans on most. */
  filled?: boolean;
  /** A glyph of its own in place of `icon`. */
  children?: ReactNode;
}) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      style={({ pressed }) => [
        styles.iconButton,
        filled && { backgroundColor: c.muted },
        pressed && { backgroundColor: c.accent },
        disabled && { opacity: 0.4 },
      ]}
    >
      {children ?? (icon ? <Feather name={icon} size={size} color={color ?? c.foreground} /> : null)}
    </Pressable>
  );
}

export function back() {
  if (router.canGoBack()) router.back();
  else router.replace('/bots');
}

/** The scrolling page around a section, for a part that brings another part into view. */
const PageScroll = createContext<{
  scroll: RefObject<ComponentRef<typeof ScrollView> | null>;
  content: RefObject<ComponentRef<typeof View> | null>;
} | null>(null);

/**
 * Scrolls the page so `target` sits near the top of the screen, as a link to a form further up
 * the page does. Does nothing outside a scrolling `Page`.
 */
export function usePageScroll() {
  const page = useContext(PageScroll);
  return (target: ComponentRef<typeof View> | null) => {
    const scroll = page?.scroll.current;
    const content = page?.content.current;
    if (!scroll || !content || !target) return;
    target.measureLayout(content, (_x, y) => scroll.scrollTo({ y: Math.max(0, y - 24), animated: true }));
  };
}

/**
 * A screen with a back button and a title, its content scrolling under it. `scroll` false leaves
 * the content to lay itself out, for lists that scroll on their own.
 */
export function Page({
  title,
  right,
  children,
  scroll = true,
  onBack = back,
}: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
  scroll?: boolean;
  onBack?: () => void;
}) {
  const c = useColors();
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const contentRef = useRef<ComponentRef<typeof View>>(null);
  const pageScroll = useMemo(() => ({ scroll: scrollRef, content: contentRef }), []);
  return (
    <SafeAreaView style={[styles.fill, { backgroundColor: c.background }]} edges={['top', 'left', 'right']}>
      <View style={styles.header}>
        <IconButton icon="chevron-left" size={24} label={t('chat.back')} onPress={onBack} />
        <Text
          style={[styles.headerTitle, { color: c.foreground }]}
          numberOfLines={1}
          accessibilityRole="header"
        >
          {title}
        </Text>
        <View style={styles.headerRight}>{right ?? <View style={styles.iconButton} />}</View>
      </View>
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {scroll ? (
          <ScrollView
            ref={scrollRef}
            innerViewRef={contentRef}
            contentContainerStyle={styles.pageContent}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
          >
            <PageScroll.Provider value={pageScroll}>{children}</PageScroll.Provider>
          </ScrollView>
        ) : (
          children
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/** A titled group of rows on a card, as the settings sections are. */
export function Section({
  title,
  footer,
  children,
}: {
  title?: string;
  footer?: string;
  children: ReactNode;
}) {
  const c = useColors();
  return (
    <View style={styles.section}>
      {title ? <Text style={[styles.sectionTitle, { color: c.mutedForeground }]}>{title}</Text> : null}
      <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>{children}</View>
      {footer ? <Text style={[styles.sectionFooter, { color: c.mutedForeground }]}>{footer}</Text> : null}
    </View>
  );
}

/** One line in a section: an icon, a label with an optional detail, and what tapping it does. */
export function Row({
  icon,
  label,
  detail,
  value,
  onPress,
  destructive,
  chevron = !!onPress,
  right,
  disabled,
  busy,
  detailLines = 3,
}: {
  icon?: IconName;
  label: string;
  detail?: string | null;
  /** How many lines the detail may take; 0 shows all of it, for a detail that explains a step. */
  detailLines?: number;
  value?: string | null;
  onPress?: () => void;
  destructive?: boolean;
  chevron?: boolean;
  right?: ReactNode;
  disabled?: boolean;
  busy?: boolean;
}) {
  const c = useColors();
  const tint = destructive ? c.destructive : c.foreground;
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      onPress={onPress}
      disabled={!onPress || disabled || busy}
      style={({ pressed }) => [
        styles.row,
        pressed && { backgroundColor: c.accent },
        disabled && { opacity: 0.5 },
      ]}
    >
      {icon ? (
        <Feather name={icon} size={22} color={destructive ? c.destructive : c.mutedForeground} />
      ) : null}
      <View style={styles.rowText}>
        <Text style={[styles.rowLabel, { color: tint }]} numberOfLines={2}>
          {label}
        </Text>
        {detail ? (
          <Text
            style={[styles.rowDetail, { color: c.mutedForeground }]}
            numberOfLines={detailLines || undefined}
          >
            {detail}
          </Text>
        ) : null}
      </View>
      {value ? (
        <Text style={[styles.rowValue, { color: c.mutedForeground }]} numberOfLines={1}>
          {value}
        </Text>
      ) : null}
      {busy ? <ActivityIndicator size="small" color={c.mutedForeground} /> : right}
      {chevron && !busy ? <Feather name="chevron-right" size={22} color={c.mutedForeground} /> : null}
    </Pressable>
  );
}

export function SwitchRow({
  icon,
  label,
  detail,
  value,
  onChange,
  disabled,
}: {
  icon?: IconName;
  label: string;
  detail?: string | null;
  value: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}) {
  const c = useColors();
  return (
    <Row
      icon={icon}
      label={label}
      detail={detail}
      disabled={disabled}
      right={
        <Switch
          value={value}
          onValueChange={onChange}
          disabled={disabled}
          trackColor={{ true: c.primary, false: c.muted }}
          thumbColor={value ? c.primaryForeground : undefined}
          accessibilityLabel={label}
        />
      }
    />
  );
}

/** A labelled text box for forms on a page. */
export function LabeledInput({
  label,
  hint,
  multiline,
  style,
  ...rest
}: TextInputProps & { label: string; hint?: string }) {
  const c = useColors();
  return (
    <View style={styles.labeled}>
      <Text style={[styles.inputLabel, { color: c.foreground }]}>{label}</Text>
      <TextInput
        placeholderTextColor={c.mutedForeground}
        multiline={multiline}
        accessibilityLabel={label}
        {...rest}
        style={[
          multiline ? styles.textArea : styles.input,
          { backgroundColor: c.card, color: c.foreground, borderColor: c.border },
          style,
        ]}
      />
      {hint ? <Text style={[styles.inputHint, { color: c.mutedForeground }]}>{hint}</Text> : null}
    </View>
  );
}

/** A choice from a few options, as a row of rounded segments. */
export function Segments<V extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: V; label: string }[];
  value: V;
  onChange: (v: V) => void;
}) {
  const c = useColors();
  return (
    <View style={[styles.segments, { backgroundColor: c.muted }]}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(o.value)}
            style={[styles.segment, on && { backgroundColor: c.card }]}
          >
            <Text
              style={[styles.segmentText, { color: on ? c.foreground : c.mutedForeground }]}
              numberOfLines={1}
            >
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A rounded, small button for actions inside a page. */
export function PillButton({
  label,
  onPress,
  icon,
  variant = 'secondary',
  busy,
  disabled,
}: {
  label: string;
  onPress: () => void;
  icon?: IconName;
  variant?: 'primary' | 'secondary' | 'ghost' | 'destructive';
  busy?: boolean;
  disabled?: boolean;
}) {
  const c = useColors();
  const bg =
    variant === 'primary'
      ? c.primary
      : variant === 'secondary'
        ? c.muted
        : variant === 'destructive'
          ? c.destructive
          : 'transparent';
  const fg =
    variant === 'primary' ? c.primaryForeground : variant === 'destructive' ? '#FFFFFF' : c.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={busy || disabled}
      style={({ pressed }) => [
        styles.pill,
        { backgroundColor: bg, opacity: pressed || busy ? 0.7 : disabled ? 0.4 : 1 },
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={fg} />
      ) : icon ? (
        <Feather name={icon} size={20} color={fg} />
      ) : null}
      <Text style={[styles.pillText, { color: fg }]}>{label}</Text>
    </Pressable>
  );
}

export interface SheetItem {
  icon?: IconName;
  label: string;
  onPress: () => void;
  destructive?: boolean;
  /** Shown with a check, for the current choice in a list. */
  selected?: boolean;
}

/** A menu that slides up from the bottom, as the web app's menus open on a phone. */
export function Sheet({
  open,
  onClose,
  title,
  items,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  items?: SheetItem[];
  children?: ReactNode;
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel={t('common.close')} />
        <View
          style={[
            styles.sheet,
            { backgroundColor: c.card, borderColor: c.border, paddingBottom: Math.max(insets.bottom, 12) },
          ]}
        >
          <View style={[styles.grabber, { backgroundColor: c.border }]} />
          {title ? (
            <Text style={[styles.sheetTitle, { color: c.mutedForeground }]} numberOfLines={2}>
              {title}
            </Text>
          ) : null}
          <ScrollView style={styles.sheetScroll} keyboardShouldPersistTaps="handled">
            {items?.map((item, i) => (
              <Pressable
                key={`${item.label}-${i}`}
                accessibilityRole="button"
                onPress={() => {
                  onClose();
                  // Let the sheet close before what the item opens, so two modals never stack.
                  setTimeout(item.onPress, 250);
                }}
                style={({ pressed }) => [styles.sheetItem, pressed && { backgroundColor: c.accent }]}
              >
                {item.icon ? (
                  <Feather
                    name={item.icon}
                    size={22}
                    color={item.destructive ? c.destructive : c.foreground}
                  />
                ) : null}
                <Text
                  style={[styles.sheetLabel, { color: item.destructive ? c.destructive : c.foreground }]}
                  numberOfLines={2}
                >
                  {item.label}
                </Text>
                {item.selected ? <Feather name="check" size={22} color={c.foreground} /> : null}
              </Pressable>
            ))}
            {children}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function Empty({ icon, text }: { icon?: IconName; text: string }) {
  const c = useColors();
  return (
    <View style={styles.empty}>
      {icon ? <Feather name={icon} size={28} color={c.mutedForeground} /> : null}
      <Text style={[styles.emptyText, { color: c.mutedForeground }]}>{text}</Text>
    </View>
  );
}

export function Loading() {
  const c = useColors();
  return (
    <View style={styles.empty}>
      <ActivityIndicator color={c.mutedForeground} />
    </View>
  );
}

export function Note({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'error' }) {
  const c = useColors();
  return (
    <Text style={[styles.note, { color: tone === 'error' ? c.destructive : c.mutedForeground }]}>
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, height: 56 },
  headerTitle: { flex: 1, fontSize: 17, fontWeight: '600', textAlign: 'center' },
  headerRight: { minWidth: 40, flexDirection: 'row', justifyContent: 'flex-end' },
  iconButton: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  pageContent: { padding: 16, paddingBottom: 40, gap: 20 },
  section: { gap: 6 },
  sectionTitle: { fontSize: 15, fontWeight: '500', paddingHorizontal: 16 },
  sectionFooter: { fontSize: 15, lineHeight: 20, paddingHorizontal: 16 },
  card: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  rowText: { flex: 1, gap: 2 },
  rowLabel: { fontSize: 17, lineHeight: 22 },
  rowDetail: { fontSize: 15, lineHeight: 20 },
  rowValue: { fontSize: 17, maxWidth: '45%' },
  labeled: { gap: 6 },
  inputLabel: { fontSize: 16, fontWeight: '500', paddingHorizontal: 4 },
  inputHint: { fontSize: 15, lineHeight: 20, paddingHorizontal: 4 },
  input: { height: 48, borderRadius: 24, borderWidth: 1, paddingHorizontal: 20, fontSize: 17 },
  textArea: {
    minHeight: 112,
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
    fontSize: 17,
    lineHeight: 23,
    textAlignVertical: 'top',
  },
  segments: { flexDirection: 'row', borderRadius: 20, padding: 3 },
  segment: {
    flex: 1,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  segmentText: { fontSize: 16, fontWeight: '500' },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 36,
    borderRadius: 18,
    paddingHorizontal: 16,
  },
  pillText: { fontSize: 16, fontWeight: '500' },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
    maxHeight: '80%',
  },
  sheetScroll: { flexGrow: 0 },
  grabber: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, marginBottom: 8 },
  sheetTitle: { fontSize: 15, paddingHorizontal: 20, paddingBottom: 8 },
  sheetItem: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 50, paddingHorizontal: 20 },
  sheetLabel: { flex: 1, fontSize: 17 },
  empty: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 32 },
  emptyText: { fontSize: 16, lineHeight: 22, textAlign: 'center' },
  note: { fontSize: 15, lineHeight: 20, paddingHorizontal: 4 },
});
