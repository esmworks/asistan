import { describe, expect, it } from 'vitest';
import { formatters, initials } from './format';

describe('biçimlendirme', () => {
  const now = new Date(2026, 10, 14, 10, 0);
  it('gün etiketleri', () => {
    const { dayLabel } = formatters('tr');
    expect(dayLabel(new Date(2026, 10, 14, 9, 5).toISOString(), now)).toBe('Bugün 09:05');
    expect(dayLabel(new Date(2026, 10, 13, 22, 4).toISOString(), now)).toBe('Dün 22:04');
    expect(dayLabel(new Date(2026, 9, 3, 10, 0).toISOString(), now)).toBe('3 Ekim 10:00');
  });
  it('İngilizce gün etiketleri', () => {
    const { dayLabel, shortTime } = formatters('en');
    expect(dayLabel(new Date(2026, 10, 14, 9, 5).toISOString(), now)).toBe('Today 09:05 AM');
    expect(dayLabel(new Date(2026, 10, 13, 22, 4).toISOString(), now)).toBe('Yesterday 10:04 PM');
    expect(dayLabel(new Date(2026, 9, 3, 10, 0).toISOString(), now)).toBe('October 3 10:00 AM');
    expect(shortTime(new Date(2026, 10, 13, 22, 4).toISOString(), now)).toBe('Yesterday');
  });
  it('dosya boyutu ve baş harfler', () => {
    expect(formatters('tr').fileSize(512)).toBe('512 B');
    expect(formatters('tr').fileSize(2048)).toBe('2,0 KB');
    expect(formatters('en').fileSize(2048)).toBe('2.0 KB');
    expect(initials('erhan erbaş')).toBe('EE');
    expect(initials('ışık')).toBe('I');
  });
  it('dolar tutarı ve takvim günü', () => {
    const tr = formatters('tr');
    const en = formatters('en');
    expect(en.usd(1.5)).toBe('$1.50');
    expect(en.usd(0)).toBe('$0.00');
    // A cost too small to show as cents still shows that there was one.
    expect(en.usd(0.001)).toBe('<$0.01');
    expect(tr.usd(12.3)).toMatch(/12,30/);
    // A day key never moves to the day before, whatever the browser's time zone.
    expect(en.calendarDay('2026-11-16')).toBe('November 16');
    expect(tr.calendarDay('2026-11-16', true)).toBe('16 Kas');
  });
});
