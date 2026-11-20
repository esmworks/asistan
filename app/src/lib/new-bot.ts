import { newBotEngine, type BotEngineChoice } from '@leafbot/shared';

export type BotEngine = BotEngineChoice;
export { newBotEngine };
/** `provider/model` as its two parts; a bare id has no provider. */
export function splitPiModel(ref: string): { provider: string; model: string } {
  const i = ref.indexOf('/');
  return i > 0 ? { provider: ref.slice(0, i), model: ref.slice(i + 1) } : { provider: '', model: ref };
}
