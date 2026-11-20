import { describe, expect, it } from 'vitest';
import { createTranslator } from '@leafbot/shared';
import { en } from '@/i18n/en';
import { tr } from '@/i18n/tr';
import { toolLabel } from './toolLabel';

const t = createTranslator({ tr, en }, 'tr');
const apps = new Map([['notion', 'Notion']]);

describe('çalışan aracın adı', () => {
  it('bilinen araçları sözle söyler; bağlı uygulamayı kendi adıyla anar', () => {
    expect(toolLabel('Bash', t, apps)).toBe('Komut çalıştırıyor');
    expect(toolLabel('mcp__leafbot__run_command', t, apps)).toBe('Komut çalıştırıyor');
    expect(toolLabel('Read', t, apps)).toBe('Dosyalara bakıyor');
    expect(toolLabel('Edit', t, apps)).toBe('Dosya yazıyor');
    expect(toolLabel('WebSearch', t, apps)).toBe("Web'de arıyor");
    expect(toolLabel('mcp__leafbot__memory_search', t, apps)).toBe('Hafızasına bakıyor');
    expect(toolLabel('mcp__notion__search', t, apps)).toBe('Notion kullanıyor');
    expect(toolLabel('mcp__takvim__list', t, apps)).toBe('takvim kullanıyor');
  });

  it('tarayıcı, plan ve bilinmeyen araç için bir şey eklemez', () => {
    expect(toolLabel('mcp__leafbot__browser_click', t, apps)).toBeNull();
    expect(toolLabel('TodoWrite', t, apps)).toBeNull();
    expect(toolLabel('garip_arac', t, apps)).toBeNull();
  });
});
