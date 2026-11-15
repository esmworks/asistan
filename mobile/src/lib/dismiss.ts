import { useRef } from 'react';
import { findNodeHandle, Keyboard, TextInput, type GestureResponderEvent } from 'react-native';

type Focused = ReturnType<typeof TextInput.State.currentlyFocusedInput>;

function isFocused(e: GestureResponderEvent, input: Focused) {
  if (!input) return false;
  if ((e.target as unknown) === input) return true;
  const tag = findNodeHandle(input as never);
  return tag !== null && tag === e.nativeEvent.target;
}

/**
 * Spread on a scrolling list or page: a tap on it closes the keyboard, as tapping a conversation
 * does on a phone, even where the tap lands on a message or a row that handles it. A tap inside the
 * box being typed in, or one that moves the focus to another box, leaves the keyboard up; a drag
 * is left to the list's own keyboard handling.
 */
export function useTapToDismiss() {
  const start = useRef<{ x: number; y: number; input: Focused } | null>(null);
  return {
    onTouchStart: (e: GestureResponderEvent) => {
      const input = TextInput.State.currentlyFocusedInput();
      const { pageX: x, pageY: y } = e.nativeEvent;
      start.current = input && !isFocused(e, input) ? { x, y, input } : null;
    },
    onTouchEnd: (e: GestureResponderEvent) => {
      const s = start.current;
      start.current = null;
      if (!s) return;
      const { pageX, pageY } = e.nativeEvent;
      if (Math.abs(pageX - s.x) > 10 || Math.abs(pageY - s.y) > 10) return;
      // Wait for the tap to land: a tap on another box focuses it, and the keyboard stays.
      setTimeout(() => {
        if (TextInput.State.currentlyFocusedInput() === s.input) Keyboard.dismiss();
      }, 50);
    },
  };
}
