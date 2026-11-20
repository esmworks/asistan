import { createTranslator, type Approval } from '@leafbot/shared';
import { describe, expect, it } from 'vitest';
import { en } from '@/i18n/en';
import { tr } from '@/i18n/tr';
import { answeredText } from './MessageItem';

const card = (questions: unknown[], answer: string | null): Approval => ({
  id: 'a',
  threadId: 't',
  botId: 'b',
  kind: 'question',
  toolName: 'ask_user',
  summary: '',
  input: { questions },
  options: [],
  status: 'allowed',
  answer,
  remembered: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  decidedAt: '2026-01-01T00:00:00.000Z',
});

describe('answered question line', () => {
  const t = createTranslator({ tr, en }, 'en');

  it('says a secret answer was given, never an empty answer', () => {
    const line = answeredText(card([{ question: 'Key?', secret: true }], null), 'Bot', t, 'en');
    expect(line).toBe(t('question.secretGiven'));
  });

  it('shows a plain answer as before', () => {
    const line = answeredText(card([{ question: 'Where?', options: ['Home'] }], 'Home'), 'Bot', t, 'en');
    expect(line).toBe(t('question.answer', { answer: 'Home' }));
  });
});
