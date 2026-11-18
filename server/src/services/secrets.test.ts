import { describe, expect, it } from 'vitest';
import { noteKey, redactSecrets } from './secrets';

const M = '[x]';
const red = (s: string) => redactSecrets(s, M).text;

describe('redactSecrets', () => {
  it('replaces keys and tokens recognised by their shape', () => {
    expect(red('key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123')).toBe(`key ${M}`);
    expect(red('ghp_abcdefghijklmnopqrstuvwxyz0123456789 works')).toBe(`${M} works`);
    expect(red('AKIAABCDEFGHIJKLMNOP')).toBe(M);
    expect(red('Authorization: Bearer abcdefghijklmnop1234')).toBe(`Authorization: Bearer ${M}`);
    expect(red('-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----')).toBe(M);
  });

  it('replaces only the value after a label, in English and Turkish', () => {
    expect(red('Gmail password: hunter22')).toBe(`Gmail password: ${M}`);
    expect(red('wifi şifresi: Kedi1234')).toBe(`wifi şifresi: ${M}`);
    expect(red('Parola = "abc123!"')).toBe(`Parola = "${M}"`);
    expect(red('my password is s3cret!')).toBe(`my password is ${M}`);
  });

  it('replaces the value of a variable named for a secret, as a command sets it', () => {
    expect(red('PGPASSWORD=hunter22 psql -h db')).toBe(`PGPASSWORD=${M} psql -h db`);
    expect(red('GITHUB_TOKEN="abc123def" gh pr list')).toBe(`GITHUB_TOKEN="${M}" gh pr list`);
    expect(red('export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI')).toBe(`export AWS_SECRET_ACCESS_KEY=${M}`);
    expect(red('DB_PASS=s3cret! npm start')).toBe(`DB_PASS=${M} npm start`);
    // A folder or a switch is not a secret.
    expect(red('OLDPWD=/home/x NODE_ENV=production BYPASS=1')).toBe(
      'OLDPWD=/home/x NODE_ENV=production BYPASS=1',
    );
  });

  it('leaves prose alone', () => {
    const plain = 'The token is valid until Friday; Erhan prefers tea.';
    expect(redactSecrets(plain, M)).toEqual({ text: plain, redacted: false });
    expect(red('Şifre sıfırlama linki e-postayla gelir')).toBe('Şifre sıfırlama linki e-postayla gelir');
  });
});

describe('noteKey', () => {
  it('ignores case, spacing and closing punctuation', () => {
    expect(noteKey('  İstanbulda  yaşıyor. ')).toBe(noteKey('istanbulda yaşıyor'));
    expect(noteKey('Tea')).not.toBe(noteKey('Coffee'));
  });
});
