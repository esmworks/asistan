import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './clipboard';

/** jsdom has no copy command; this one fires the copy event as a browser does and records the data. */
function stubCopyCommand(result: boolean) {
  const written: Record<string, string> = {};
  let fieldParent: Element | null = null;
  const exec = vi.fn((command: string) => {
    if (command !== 'copy') return false;
    fieldParent = document.querySelector('textarea')?.parentElement ?? null;
    const event = new Event('copy', { cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, 'clipboardData', {
      value: { setData: (type: string, value: string) => (written[type] = value) },
    });
    document.dispatchEvent(event);
    return result;
  });
  Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
  return { exec, written, fieldParent: () => fieldParent };
}

function stubClipboardApi(writeText: () => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('copyText', () => {
  it('copies through the copy command without asking the clipboard API', async () => {
    const copy = stubCopyCommand(true);
    const writeText = vi.fn(() => Promise.reject(new Error('denied')));
    stubClipboardApi(writeText);
    expect(await copyText('https://example.test/cb', '<b>x</b>')).toBe(true);
    expect(copy.written).toEqual({ 'text/plain': 'https://example.test/cb', 'text/html': '<b>x</b>' });
    expect(writeText).not.toHaveBeenCalled();
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('falls back to the clipboard API when the copy command is refused', async () => {
    stubCopyCommand(false);
    const writeText = vi.fn(() => Promise.resolve());
    stubClipboardApi(writeText);
    expect(await copyText('abc')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('abc');
  });

  it('reports failure when both routes are refused', async () => {
    stubCopyCommand(false);
    stubClipboardApi(() => Promise.reject(new Error('denied')));
    expect(await copyText('abc')).toBe(false);
  });

  it('places its field inside the open dialog and gives focus back to the button', async () => {
    document.body.innerHTML = '<div role="dialog"><button>copy</button></div>';
    const button = document.querySelector('button')!;
    button.focus();
    const copy = stubCopyCommand(true);
    await copyText('abc');
    expect(copy.fieldParent()).toBe(document.querySelector('[role="dialog"]'));
    expect(document.activeElement).toBe(button);
  });
});
