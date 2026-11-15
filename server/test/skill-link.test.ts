import { describe, expect, it } from 'vitest';
import { fetchSkillFile, privateAddress, skillFileUrl } from '../src/services/skill-link';

describe('bağlantıdan beceri', () => {
  it('GitHub sayfa bağlantısını ham dosya adresine çevirir', () => {
    expect(skillFileUrl('https://github.com/o/r/blob/main/skills/pdf/SKILL.md').href).toBe(
      'https://raw.githubusercontent.com/o/r/main/skills/pdf/SKILL.md',
    );
    expect(skillFileUrl('https://github.com/o/r/tree/main/skills/pdf').href).toBe(
      'https://raw.githubusercontent.com/o/r/main/skills/pdf/SKILL.md',
    );
    expect(skillFileUrl('https://github.com/o/r').href).toBe(
      'https://raw.githubusercontent.com/o/r/HEAD/SKILL.md',
    );
    expect(skillFileUrl('https://example.com/a.md').href).toBe('https://example.com/a.md');
    expect(() => skillFileUrl('http://example.com/a.md')).toThrow();
  });

  it('yerel ve özel ağ adreslerini tanır', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.5',
      '169.254.169.254',
      '::1',
      'fd00::1',
      '::ffff:127.0.0.1',
      '100.100.1.1',
    ])
      expect(privateAddress(ip)).toBe(true);
    for (const ip of ['140.82.112.3', '2606:4700::1111']) expect(privateAddress(ip)).toBe(false);
  });

  it('yerel adrese giden bağlantıyı reddeder', async () => {
    await expect(fetchSkillFile('https://localhost/SKILL.md')).rejects.toMatchObject({ status: 400 });
    await expect(fetchSkillFile('bir şey')).rejects.toMatchObject({ status: 400 });
  });
});
