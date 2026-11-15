import { describe, expect, it } from 'vitest';
import { base32, totp, totpSecret } from '../src/totp';

describe('tek seferlik kod', () => {
  // RFC 6238 test secret "12345678901234567890" in base32.
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  it('RFC 6238 örneklerini verir', () => {
    expect(totp(secret, 59_000, 8)).toBe('94287082');
    expect(totp(secret, 1_111_111_109_000, 8)).toBe('07081804');
    expect(totp(secret, 1_234_567_890_000, 8)).toBe('89005924');
    expect(totp(secret, 59_000)).toBe('287082');
  });

  it('düz metni ve otpauth bağlantısını tanır; geçersizi reddeder', () => {
    expect(totpSecret('gezd gnbv gy3t qojq')).toBe('GEZDGNBVGY3TQOJQ');
    expect(totpSecret('otpauth://totp/Site:ayse?secret=GEZDGNBVGY3TQOJQ&issuer=Site')).toBe(
      'GEZDGNBVGY3TQOJQ',
    );
    expect(totpSecret('123456')).toBeNull();
    expect(base32('MZXW6===')?.toString()).toBe('foo');
  });
});
