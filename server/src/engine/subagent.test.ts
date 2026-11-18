import { describe, expect, it } from 'vitest';
import { SUBAGENT_RESULT_MAX, subagentAnswer } from './types';

describe('alt ajanın cevabı', () => {
  it('cevabın ardındaki kimlik ve kullanım satırları karta girmez', () => {
    const content = [
      { type: 'text', text: 'Üç kaynak buldum:\n- a\n- b' },
      {
        type: 'text',
        text: 'agentId: a1b2c3 (use SendMessage to continue this agent)\n<usage>total_tokens: 1200\ntool_uses: 4\nduration_ms: 9000</usage>',
      },
    ];
    expect(subagentAnswer(content)).toBe('Üç kaynak buldum:\n- a\n- b');
  });

  it('cevabın kendi içindeki agentId satırı kalır', () => {
    expect(subagentAnswer('Bulgular:\nagentId: 42 varsayılan\nbitti\nagentId: x1 (devam için)')).toBe(
      'Bulgular:\nagentId: 42 varsayılan\nbitti',
    );
  });

  it('düz metni olduğu gibi alır ve kısaltır', () => {
    expect(subagentAnswer('  tamam  ')).toBe('tamam');
    expect(subagentAnswer('x'.repeat(SUBAGENT_RESULT_MAX + 50))).toHaveLength(SUBAGENT_RESULT_MAX);
    expect(subagentAnswer(null)).toBe('');
  });
});
