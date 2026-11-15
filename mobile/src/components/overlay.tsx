import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  Alert,
  Animated,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t } from '@/i18n';
import { useColors } from '@/lib/theme';

/**
 * Things that float over any screen: a short note at the bottom (a toast, with an optional action
 * such as Undo) and a box that asks for one line of text. Both are opened by a plain call from
 * anywhere and drawn by <Overlays/>, mounted once at the root.
 */

interface ToastState {
  id: number;
  text: string;
  action?: { label: string; onPress: () => void };
  tone: 'normal' | 'error';
}

interface AskState {
  id: number;
  title: string;
  message?: string;
  initial: string;
  placeholder?: string;
  maxLength?: number;
  secure?: boolean;
  multiline?: boolean;
  confirmLabel?: string;
  resolve: (v: string | null) => void;
}

let toastState: ToastState | null = null;
let askState: AskState | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

/** A short note at the bottom of the screen; with `action`, a button on it (Undo, Open). */
export function toast(
  text: string,
  opts: { action?: { label: string; onPress: () => void }; tone?: 'normal' | 'error' } = {},
) {
  toastState = { id: ++seq, text, action: opts.action, tone: opts.tone ?? 'normal' };
  emit();
}

export function toastError(e: unknown) {
  toast(e instanceof Error ? e.message : String(e), { tone: 'error' });
}

/** Asks for one line (or a few) of text; null when cancelled. */
export function askText(
  opts: Omit<AskState, 'id' | 'resolve' | 'initial'> & { initial?: string },
): Promise<string | null> {
  return new Promise((resolve) => {
    askState?.resolve(null);
    askState = { ...opts, id: ++seq, initial: opts.initial ?? '', resolve };
    emit();
  });
}

/** Asks yes or no in the phone's own alert; true for yes. */
export function confirm(opts: {
  title: string;
  message?: string;
  confirmLabel?: string;
  destructive?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      opts.title,
      opts.message,
      [
        { text: t('common.cancel'), style: 'cancel', onPress: () => resolve(false) },
        {
          text: opts.confirmLabel ?? t('common.ok'),
          style: opts.destructive ? 'destructive' : 'default',
          onPress: () => resolve(true),
        },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

export function Overlays() {
  const toastNow = useSyncExternalStore(subscribe, () => toastState);
  const askNow = useSyncExternalStore(subscribe, () => askState);
  return (
    <>
      {toastNow ? <Toast key={toastNow.id} state={toastNow} /> : null}
      <AskBox state={askNow} />
    </>
  );
}

/** The height of the iOS keyboard while it is up; Android resizes the window itself. */
function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const show = Keyboard.addListener('keyboardWillShow', (e) => setHeight(e.endCoordinates.height));
    const hide = Keyboard.addListener('keyboardWillHide', () => setHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return height;
}

function Toast({ state }: { state: ToastState }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  // A note under the keyboard would never be seen, so it rides above it.
  const keyboard = useKeyboardHeight();
  const [fade] = useState(() => new Animated.Value(0));
  useEffect(() => {
    Animated.timing(fade, { toValue: 1, duration: 150, useNativeDriver: true }).start();
    const timer = setTimeout(
      () => {
        Animated.timing(fade, { toValue: 0, duration: 200, useNativeDriver: true }).start(() => {
          if (toastState?.id === state.id) {
            toastState = null;
            emit();
          }
        });
      },
      state.action ? 10_000 : 4000,
    );
    return () => clearTimeout(timer);
  }, [fade, state]);
  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.toastWrap,
        { bottom: keyboard > 0 ? keyboard + 12 : Math.max(insets.bottom, 12) + 64, opacity: fade },
      ]}
    >
      <View
        style={[
          styles.toast,
          { backgroundColor: c.primary, borderColor: state.tone === 'error' ? c.destructive : c.primary },
        ]}
        accessibilityLiveRegion="polite"
      >
        <Text style={[styles.toastText, { color: c.primaryForeground }]} numberOfLines={4}>
          {state.text}
        </Text>
        {state.action ? (
          <Pressable
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => {
              state.action?.onPress();
              toastState = null;
              emit();
            }}
          >
            <Text style={[styles.toastAction, { color: c.primaryForeground }]}>{state.action.label}</Text>
          </Pressable>
        ) : null}
      </View>
    </Animated.View>
  );
}

function AskBox({ state }: { state: AskState | null }) {
  const close = (v: string | null) => {
    state?.resolve(v);
    if (askState === state) {
      askState = null;
      emit();
    }
  };
  return (
    <Modal visible={!!state} transparent animationType="fade" onRequestClose={() => close(null)}>
      {/* Keyed by the question, so each one starts from its own text. */}
      {state ? <AskForm key={state.id} state={state} close={close} /> : null}
    </Modal>
  );
}

function AskForm({ state, close }: { state: AskState; close: (v: string | null) => void }) {
  const c = useColors();
  const [value, setValue] = useState(state.initial);
  return (
    <KeyboardAvoidingView style={styles.askScrim} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={[styles.askBox, { backgroundColor: c.card, borderColor: c.border }]}>
        <Text style={[styles.askTitle, { color: c.foreground }]}>{state.title}</Text>
        {state.message ? (
          <Text style={[styles.askMessage, { color: c.mutedForeground }]}>{state.message}</Text>
        ) : null}
        <TextInput
          value={value}
          onChangeText={setValue}
          autoFocus
          placeholder={state.placeholder}
          placeholderTextColor={c.mutedForeground}
          maxLength={state.maxLength}
          secureTextEntry={state.secure}
          multiline={state.multiline}
          onSubmitEditing={state.multiline ? undefined : () => close(value)}
          returnKeyType={state.multiline ? 'default' : 'done'}
          accessibilityLabel={state.title}
          style={[
            state.multiline ? styles.askArea : styles.askInput,
            { color: c.foreground, borderColor: c.border, backgroundColor: c.background },
          ]}
        />
        <View style={styles.askButtons}>
          <Pressable accessibilityRole="button" onPress={() => close(null)} style={styles.askButton}>
            <Text style={[styles.askButtonText, { color: c.mutedForeground }]}>{t('common.cancel')}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => close(value)}
            style={[styles.askButton, styles.askPrimary, { backgroundColor: c.primary }]}
          >
            <Text style={[styles.askButtonText, { color: c.primaryForeground }]}>
              {state.confirmLabel ?? t('common.save')}
            </Text>
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  toastWrap: { position: 'absolute', left: 16, right: 16, alignItems: 'center' },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    borderRadius: 20,
    borderWidth: 1,
    paddingHorizontal: 18,
    paddingVertical: 12,
    maxWidth: 480,
  },
  toastText: { flexShrink: 1, fontSize: 14, lineHeight: 20 },
  toastAction: { fontSize: 14, fontWeight: '600' },
  askScrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', padding: 24 },
  askBox: { borderRadius: 24, borderWidth: StyleSheet.hairlineWidth, padding: 20, gap: 12 },
  askTitle: { fontSize: 17, fontWeight: '600' },
  askMessage: { fontSize: 14, lineHeight: 20 },
  askInput: { height: 44, borderRadius: 22, borderWidth: 1, paddingHorizontal: 16, fontSize: 16 },
  askArea: {
    minHeight: 96,
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingTop: 10,
    fontSize: 15,
    textAlignVertical: 'top',
  },
  askButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  askButton: {
    height: 40,
    borderRadius: 20,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  askPrimary: {},
  askButtonText: { fontSize: 15, fontWeight: '500' },
});
