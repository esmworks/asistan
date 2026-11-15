import { describe, expect, it } from 'vitest';
import { newBotEngine, splitPiModel } from './new-bot';

describe('new bot engine', () => {
  it('starts on Claude unless another provider and its model were picked', () => {
    expect(newBotEngine(undefined)).toEqual({ engine: 'claude', model: '' });
    expect(newBotEngine({ defaultEngine: 'pi', piModel: '' })).toEqual({ engine: 'claude', model: '' });
    expect(newBotEngine({ defaultEngine: 'claude', piModel: 'openai/gpt-4o' })).toEqual({
      engine: 'claude',
      model: '',
    });
    expect(newBotEngine({ defaultEngine: 'pi', piModel: 'openai/gpt-4o' })).toEqual({
      engine: 'pi',
      model: 'openai/gpt-4o',
    });
  });

  it('splits at the first slash, so model ids with slashes stay whole', () => {
    expect(splitPiModel('openrouter/anthropic/claude-x')).toEqual({
      provider: 'openrouter',
      model: 'anthropic/claude-x',
    });
    expect(splitPiModel('gpt-4o')).toEqual({ provider: '', model: 'gpt-4o' });
  });
});
