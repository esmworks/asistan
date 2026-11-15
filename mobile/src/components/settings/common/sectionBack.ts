import { useEffect } from 'react';
import { BackHandler } from 'react-native';

/**
 * A section that shows a form in place of its list can claim the title bar's back arrow (and the
 * Android back button) while the form is open, so going back closes the form instead of the
 * whole section.
 */
let close: (() => void) | null = null;

/** Called by the title bar's back arrow; true when an open form took it. */
export function closeSectionForm(): boolean {
  if (!close) return false;
  close();
  return true;
}

export function useSectionBack(active: boolean, onClose: () => void) {
  useEffect(() => {
    if (!active) return;
    close = onClose;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => {
      if (close === onClose) close = null;
      sub.remove();
    };
    // `onClose` only calls state setters; it is not a dependency so the claim is not re-made.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}
