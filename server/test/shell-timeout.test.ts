import { describe, expect, it } from 'vitest';
import { shellTimeoutHint } from '../src/engine/claude';
import { FAILURE_STOP, failureStreak } from '../src/engine/failures';

describe('kabuk zaman aşımı ipucu', () => {
  it('süresi dolan komuta daha uzun süre ya da arka plan önerir', () => {
    const hint = shellTimeoutHint(
      'Bash',
      { command: 'ffmpeg -i a.mov b.mp4' },
      'Exit code 143\nCommand timed out after 2m 0s',
    );
    expect(hint).toContain('600000');
    expect(hint).toContain('shorter pieces');
  });

  it('diskin kökünü tarayan komuta belirli bir klasörde aramasını söyler', () => {
    const hint = shellTimeoutHint(
      'Bash',
      { command: 'sudo find / -name x' },
      'Command timed out after 2m 0s',
    );
    expect(hint).toContain('-maxdepth');
    expect(hint).not.toContain('shorter pieces');
  });

  it('başka hatalarda ve araçlarda susar', () => {
    expect(shellTimeoutHint('Bash', { command: 'ls' }, 'Exit code 1')).toBeNull();
    expect(shellTimeoutHint('Read', {}, 'Command timed out after 2m 0s')).toBeNull();
  });
});

describe('aynı hatanın tekrarı', () => {
  it('aynı çağrı aynı biçimde üç kez üst üste başarısız olunca söyler', () => {
    const f = failureStreak();
    expect(f.note('Bash', { command: 'npm test' }, 'Exit code 1')).toBeNull();
    expect(f.note('Bash', { command: 'npm test' }, 'Exit code 1')).toBeNull();
    expect(f.note('Bash', { command: 'npm test' }, 'Exit code 1')).toContain('3 times');
  });

  it('başarılı bir çağrı ya da farklı bir çağrı sayımı sıfırlar', () => {
    const f = failureStreak();
    f.note('Bash', { command: 'a' }, 'x');
    f.note('Bash', { command: 'a' }, 'x');
    f.reset();
    expect(f.note('Bash', { command: 'a' }, 'x')).toBeNull();
    f.note('Bash', { command: 'a' }, 'x');
    expect(f.note('Bash', { command: 'b' }, 'x')).toBeNull();
    expect(f.note('Bash', { command: 'b' }, 'y')).toBeNull();
  });

  it('uyarıya rağmen sürerse turu bir kez durdurur', () => {
    const stops: [string, number][] = [];
    const f = failureStreak((tool, count) => stops.push([tool, count]));
    for (let i = 0; i < FAILURE_STOP + 2; i++) f.note('Bash', { command: 'npm test' }, 'Exit code 1');
    expect(stops).toEqual([['Bash', FAILURE_STOP]]);
  });
});
