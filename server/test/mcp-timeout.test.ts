import { describe, expect, it } from 'vitest';
import { mcpCallSeconds } from '../src/config';

describe('bağlı uygulama çağrı süresi', () => {
  it('varsayılan beş dakika; sınırların dışındaki değer sınıra çekilir', () => {
    expect(mcpCallSeconds(undefined)).toBe(300);
    expect(mcpCallSeconds('abc')).toBe(300);
    expect(mcpCallSeconds('900')).toBe(900);
    expect(mcpCallSeconds('2')).toBe(10);
    expect(mcpCallSeconds('99999')).toBe(3600);
  });
});
