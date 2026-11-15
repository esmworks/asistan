import type { Settings } from './api';

export interface BotEngine {
  engine: 'claude' | 'pi';
  model: string;
}

/** The engine and model a new bot starts with: the provider picked in the settings, else Claude. */
export function newBotEngine(settings?: Pick<Settings, 'defaultEngine' | 'piModel'>): BotEngine {
  return settings?.defaultEngine === 'pi' && settings.piModel
    ? { engine: 'pi', model: settings.piModel }
    : { engine: 'claude', model: '' };
}

/** `provider/model` as its two parts; a bare id has no provider. */
export function splitPiModel(ref: string): { provider: string; model: string } {
  const i = ref.indexOf('/');
  return i > 0 ? { provider: ref.slice(0, i), model: ref.slice(i + 1) } : { provider: '', model: ref };
}
