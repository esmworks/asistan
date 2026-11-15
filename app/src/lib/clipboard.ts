/**
 * Puts text on the clipboard, with HTML beside it when given; false when the page may not.
 * The copy command goes first: it works within the click itself, also where the clipboard API is
 * refused (pages served without https, the desktop app, which grants no permissions).
 */
export async function copyText(text: string, html?: string): Promise<boolean> {
  const onCopy = (e: ClipboardEvent) => {
    if (!e.clipboardData) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', text);
    if (html) e.clipboardData.setData('text/html', html);
  };
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.left = '0';
  area.style.opacity = '0';
  const focused = document.activeElement as HTMLElement | null;
  // Inside an open dialog the field goes into it: a dialog keeps focus within itself and would pull
  // it back from a field placed outside.
  (focused?.closest('[role="dialog"]') ?? document.body).append(area);
  area.select();
  document.addEventListener('copy', onCopy);
  let done = false;
  try {
    done = document.execCommand('copy');
  } catch {
    done = false;
  } finally {
    document.removeEventListener('copy', onCopy);
    area.remove();
    focused?.focus({ preventScroll: true });
  }
  if (done) return true;
  try {
    if (html && typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        }),
      ]);
    } else {
      await navigator.clipboard.writeText(text);
    }
    return true;
  } catch {
    return false;
  }
}
