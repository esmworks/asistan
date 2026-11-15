/** The part of `before` that becomes something else in `after`: its range and what replaces it. */
export function changedRange(before: string, after: string): { start: number; end: number; insert: string } {
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) start++;
  let tail = 0;
  while (tail < max - start && before[before.length - 1 - tail] === after[after.length - 1 - tail]) {
    tail++;
  }
  return { start, end: before.length - tail, insert: after.slice(start, after.length - tail) };
}

/**
 * Puts `next` into the text box as if typed, so Ctrl+Z / ⌘Z takes it back like any other edit;
 * setting the value from code would clear the box's undo history. The box's input event follows,
 * so a controlled box picks up the new text there. The caret ends at `caret`.
 */
export function editAsTyped(el: HTMLTextAreaElement, next: string, caret: number) {
  const { start, end, insert } = changedRange(el.value, next);
  el.focus();
  el.setSelectionRange(start, end);
  // Still the only way to edit a text box through the browser's own undo stack.
  const typed = insert ? document.execCommand('insertText', false, insert) : document.execCommand('delete');
  if (!typed || el.value !== next) {
    el.value = next;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  el.setSelectionRange(caret, caret);
}
