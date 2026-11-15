import { describe, expect, it } from 'vitest';
import { readableError } from '../src/util';

describe('sağlayıcı hata cümlesi', () => {
  it('JSON zarfının kendi cümlesini ve makine kodunu gösterir', () => {
    const raw =
      'API Error: 402 {"type":"error","error":{"type":"billing_error","message":"Your credit balance is too low."}}';
    expect(readableError(raw)).toBe('API Error: 402: Your credit balance is too low. (billing_error)');
    expect(readableError('{"error":{"message":"Bad key","code":"invalid_api_key"}}')).toBe(
      'Bad key (invalid_api_key)',
    );
    expect(readableError('HTTP 500 {"message":"Upstream is down"}')).toBe('HTTP 500: Upstream is down');
  });

  it('zarf yoksa ya da okunamıyorsa iletiyi olduğu gibi bırakır', () => {
    expect(readableError('Connection reset')).toBe('Connection reset');
    expect(readableError('HTTP 400 {"error":{"type":"x"')).toBe('HTTP 400 {"error":{"type":"x"');
    expect(readableError('HTTP 400 {"ok":false}')).toBe('HTTP 400 {"ok":false}');
  });

  it('çok uzun cümleyi keser', () => {
    const long = 'a'.repeat(900);
    expect(readableError(`{"message":"${long}"}`).length).toBe(500);
  });
});
