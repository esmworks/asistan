import { describe, expect, it } from 'vitest';
import { cardBrand, hasSecretShape, luhn, maskCardNumbers, maskSecretShapes } from './secret-shapes';

describe('kart numaraları', () => {
  it('kontrol hanesini ve kart ağını tanır', () => {
    // Published test card numbers.
    expect(luhn('4242424242424242')).toBe(true);
    expect(luhn('4242424242424241')).toBe(false);
    expect(cardBrand('4242424242424242')).toBe('visa');
    expect(cardBrand('5555555555554444')).toBe('mastercard');
    expect(cardBrand('2223003122003222')).toBe('mastercard');
    expect(cardBrand('378282246310005')).toBe('amex');
    expect(cardBrand('6011111111111117')).toBe('discover');
  });

  it('metindeki kart numarasını gizler, başka uzun sayılara dokunmaz', () => {
    expect(maskCardNumbers('Kart: 4242 4242 4242 4242, teşekkürler', '•')).toBe('Kart: •, teşekkürler');
    expect(maskCardNumbers('5555-5555-5555-4444', '•')).toBe('•');
    expect(maskSecretShapes('amex 378282246310005', '•')).toBe('amex •');
    // Beside other numbers: an expiry date, a security code, an amount.
    expect(maskCardNumbers('Kart 4242 4242 4242 4242 12/34 cvc 987', '•')).toBe('Kart • 12/34 cvc 987');
    expect(maskCardNumbers('3 adet 4242424242424242 1234', '•')).toBe('3 adet • 1234');
    expect(maskCardNumbers('No: 5555-5555-5555-4444 - 01/30', '•')).toBe('No: • - 01/30');
    expect(hasSecretShape('Kart 4242 4242 4242 4242 12/34')).toBe(true);
    // An order number that fails the check digit, a phone number, a date.
    for (const plain of [
      'Sipariş 4242424242424241',
      'Tel 0532 123 45 67',
      '2026-11-19',
      'id 1234567890123',
    ]) {
      expect(maskCardNumbers(plain, '•')).toBe(plain);
    }
    expect(hasSecretShape('numaram 4242424242424242')).toBe(true);
    expect(hasSecretShape('sipariş 4242424242424241')).toBe(false);
  });
});
