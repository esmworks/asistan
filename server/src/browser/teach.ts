/**
 * Teaching a task by showing it: while the person drives a bot's browser in teach mode, each click,
 * typing and page change is written down with what it was done to (a button's words, a field's
 * label), so the steps can be read back as a skill. What goes into a password field is never kept.
 */
export type TeachStep =
  | { kind: 'open'; url: string }
  | { kind: 'click'; target: Target; url: string }
  | { kind: 'type'; target: Target; text: string; secret: boolean; url: string }
  | { kind: 'key'; key: string; url: string }
  | { kind: 'nav'; action: 'back' | 'forward' | 'reload'; url: string };

/** What a step was done to, as a person would name it. */
export interface Target {
  /** button, link, field, checkbox, menu, option or element. */
  what: string;
  label: string;
  secret: boolean;
}

/** The most steps one lesson keeps; a longer demonstration is better taught in parts. */
export const MAX_STEPS = 200;

/**
 * Runs in the page: what is at a point, or has the focus, named as the person would see it. The
 * nearest clickable or labelled ancestor stands for what was hit (a click on a button's icon is a
 * click on the button).
 */
export const DESCRIBE = `(arg) => {
  const pick = (el) => (el && el.closest('a,button,input,textarea,select,summary,label,[role],[contenteditable="true"]')) || el;
  const el = pick(arg ? document.elementFromPoint(arg[0], arg[1]) : document.activeElement);
  if (!el || el === document.body || el === document.documentElement) return null;
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();
  const role = (el.getAttribute('role') || '').toLowerCase();
  const byId = el.id ? document.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null;
  const text = (v) => (v || '').trim().replace(/\\s+/g, ' ');
  const label =
    text(el.getAttribute('aria-label')) ||
    text(byId && byId.innerText) ||
    text(el.getAttribute('placeholder')) ||
    text(el.getAttribute('title')) ||
    (tag === 'input' || tag === 'textarea' || tag === 'select' ? '' : text(el.innerText)) ||
    text(el.getAttribute('alt')) ||
    text(el.getAttribute('name')) ||
    text(type === 'submit' || type === 'button' ? el.value : '');
  const what =
    tag === 'a' || role === 'link' ? 'link'
    : tag === 'button' || role === 'button' || type === 'submit' || type === 'button' ? 'button'
    : type === 'checkbox' || type === 'radio' || role === 'checkbox' || role === 'switch' ? 'checkbox'
    : tag === 'select' || role === 'combobox' || role === 'listbox' ? 'menu'
    : role === 'option' || role === 'menuitem' || role === 'tab' ? 'option'
    : tag === 'input' || tag === 'textarea' || el.isContentEditable || role === 'textbox' ? 'field'
    : 'element';
  const secret = type === 'password' || /one-time-code|current-password|new-password/.test(el.getAttribute('autocomplete') || '');
  return { what, label: label.slice(0, 80), secret };
}`;

/** Adds what the person typed to the step it belongs to: the last typing into the same field. */
export function addTyping(steps: TeachStep[], target: Target, text: string, url: string) {
  const last = steps.at(-1);
  if (last?.kind === 'type' && last.target.label === target.label && last.target.what === target.what) {
    if (!last.secret) last.text += text;
    return;
  }
  steps.push({ kind: 'type', target, text: target.secret ? '' : text, secret: target.secret, url });
}

/** A lesson's steps as numbered lines of a skill, in the server's language. */
export function stepsText(
  steps: TeachStep[],
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const lines: string[] = [];
  let at = '';
  const named = (x: Target) =>
    x.label
      ? t('teach.target', { what: t(`teach.what.${x.what}`), label: x.label })
      : t(`teach.what.${x.what}`);
  for (const s of steps) {
    // A page the person arrived at by a click or a key, not by typing its address.
    if (s.kind !== 'open' && s.url && at && s.url !== at) lines.push(t('teach.step.arrive', { url: s.url }));
    if (s.kind === 'open') lines.push(t('teach.step.open', { url: s.url }));
    else if (s.kind === 'click') lines.push(t('teach.step.click', { target: named(s.target) }));
    else if (s.kind === 'type')
      lines.push(
        s.secret
          ? t('teach.step.secret', { target: named(s.target) })
          : t('teach.step.type', { text: s.text, target: named(s.target) }),
      );
    else if (s.kind === 'key') lines.push(t('teach.step.key', { key: s.key }));
    else lines.push(t(`teach.step.${s.action}`));
    at = s.url;
  }
  return lines.map((l, i) => `${i + 1}. ${l}`).join('\n');
}
