import { describe, expect, it } from 'vitest';
import { createTranslator } from '@yumakbot/shared';
import { en } from '@/i18n/en';
import { tr } from '@/i18n/tr';
import { ruleLabel } from './ruleLabel';

const t = createTranslator({ tr, en }, 'tr');
const apps = new Map([['leafdesk', 'Leafdesk']]);

describe('izin kuralının okunur adı', () => {
  it('bağlantı aracını servis ve araç adıyla anar', () => {
    expect(ruleLabel('mcp__leafdesk__create_database', t, apps)).toBe('Leafdesk: “create_database” aracı');
    expect(ruleLabel('mcp__leafdesk__*', t, apps)).toBe('Leafdesk: tüm araçlar');
    expect(ruleLabel('mcp__leafdesk__get_page(*abc*)', t, apps)).toBe('Leafdesk: “get_page” aracı (*abc*)');
    // A connection no longer here keeps its short name.
    expect(ruleLabel('mcp__takvim__list', t, apps)).toBe('takvim: “list” aracı');
  });

  it('kendi araçlarında öneki atar; düz kuralları olduğu gibi bırakır', () => {
    expect(ruleLabel('mcp__yumakbot__bot_send', t, apps)).toBe('bot_send');
    expect(ruleLabel('Bash(git push*)', t, apps)).toBeNull();
    expect(ruleLabel('WebFetch', t, apps)).toBeNull();
  });

  it('İngilizce', () => {
    const t2 = createTranslator({ tr, en }, 'en');
    expect(ruleLabel('mcp__leafdesk__create_database', t2, apps)).toBe(
      'Leafdesk: the “create_database” tool',
    );
  });
});
