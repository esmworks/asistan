import type { T } from '../i18n';
import { BrowserError } from './manager';

/** A browser problem in the asker's language. */
export function browserErrorText(err: unknown, t: T): string {
  if (!(err instanceof BrowserError)) {
    return t('browser.error', { message: ((err as Error).message ?? String(err)).split('\n')[0]! });
  }
  switch (err.code) {
    case 'unavailable':
      return t('browser.unavailable');
    case 'userControl':
      return t('browser.userControl');
    case 'full':
      return t('browser.full');
    case 'busy':
      return t('browser.busy');
    case 'badUrl':
      return t('browser.badUrl', { url: err.message });
    case 'launch':
      return t('browser.launchFailed', { message: err.message });
    case 'hung':
      return t('browser.hung', { seconds: err.message });
    case 'staleRef':
      return t('browser.staleRef', { ref: err.message });
    case 'covered':
      return t('browser.covered', { cover: err.message });
    case 'tabs':
      return t('browser.tooManyTabs', { max: err.message });
  }
}
