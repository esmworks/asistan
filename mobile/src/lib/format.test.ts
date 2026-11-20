import { createTranslator } from '@leafbot/shared/i18n';
import { describe, expect, it } from 'vitest';
import { catalogs, type MessageKey } from '../i18n/catalogs';
import { formatters, needsDivider } from './format';

const now = new Date(2026, 10, 15, 18, 30);
const at = (d: number, h = 9, m = 5) => new Date(2026, 10, d, h, m).toISOString();
const trF = formatters('tr', createTranslator<MessageKey>(catalogs, 'tr'));
const enF = formatters('en', createTranslator<MessageKey>(catalogs, 'en'));

describe('format', () => {
  it('labels days above messages', () => {
    expect(trF.dayLabel(at(15, 16, 50), now)).toBe('Bugün 16:50');
    expect(trF.dayLabel(at(14), now)).toBe('Dün 09:05');
    expect(trF.dayLabel(at(10), now)).toMatch(/^Salı 09:05$/);
    expect(trF.dayLabel(at(1), now)).toBe('1 Kasım 09:05');
    expect(trF.dayLabel(new Date(2025, 2, 3, 9, 5).toISOString(), now)).toBe('3 Mart 2025 09:05');
    expect(enF.dayLabel(at(14), now)).toMatch(/^Yesterday 09:05/);
  });

  it('words a bare calendar day', () => {
    expect(trF.calendarDay('2026-11-16')).toBe('16 Kasım');
    expect(enF.calendarDay('2026-11-16')).toBe('November 16');
  });

  it('shortens times in the bot list', () => {
    expect(trF.shortTime(at(15), now)).toBe('09:05');
    expect(trF.shortTime(at(14), now)).toBe('Dün');
    expect(trF.shortTime(at(10), now)).toBe('Sal');
    expect(trF.shortTime(at(1), now)).toBe('1 Kasım');
  });

  it('puts a date line after an hour of quiet', () => {
    expect(needsDivider(undefined, { createdAt: at(15) })).toBe(true);
    expect(needsDivider({ createdAt: at(15, 9, 0) }, { createdAt: at(15, 9, 59) })).toBe(false);
    expect(needsDivider({ createdAt: at(15, 9, 0) }, { createdAt: at(15, 10, 1) })).toBe(true);
  });
});
