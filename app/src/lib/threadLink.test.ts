import { describe, expect, it } from 'vitest';
import { linkedThread, sameServerThread, threadLink } from './threadLink';

describe('konuşma bağlantısı', () => {
  it('konuşmayı açan adresi verir ve geri okur', () => {
    const link = threadLink('abc-123', { origin: 'https://yumakbot.ornek', pathname: '/' });
    expect(link).toBe('https://yumakbot.ornek/?thread=abc-123');
    expect(linkedThread(new URL(link).search)).toBe('abc-123');
  });

  it('boş ya da garip bir değeri konuşma saymaz', () => {
    expect(linkedThread('')).toBeNull();
    expect(linkedThread('?thread=')).toBeNull();
    expect(linkedThread('?thread=../../x')).toBeNull();
  });

  it('mesajdaki bağlantı bu sunucunun konuşmasıysa onu tanır, başka adresleri tanımaz', () => {
    const at = { origin: 'https://yumakbot.ornek', pathname: '/', href: 'https://yumakbot.ornek/' };
    expect(sameServerThread('https://yumakbot.ornek/?thread=abc-123', at)).toBe('abc-123');
    expect(sameServerThread('/?thread=abc-123', at)).toBe('abc-123');
    expect(sameServerThread('https://baska.ornek/?thread=abc-123', at)).toBeNull();
    expect(sameServerThread('https://yumakbot.ornek/docs?thread=abc-123', at)).toBeNull();
    expect(sameServerThread('https://yumakbot.ornek/', at)).toBeNull();
    expect(sameServerThread('javascript:alert(1)', at)).toBeNull();
    // The desktop app's own link, pasted into a chat.
    expect(sameServerThread('yumakbot://thread/abc-123', at)).toBe('abc-123');
    expect(sameServerThread('yumakbot://thread/../x', at)).toBeNull();
  });
});
