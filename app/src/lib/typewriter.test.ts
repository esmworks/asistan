import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTypewriter } from './typewriter';

describe('harf harf yazım', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
  });
  afterEach(() => vi.useRealTimers());

  it('canlı akışı harf harf açar ve sonunda tümünü gösterir', () => {
    const { result } = renderHook(() => useTypewriter('Merhaba dünya', 'turn-1', true));
    expect(result.current).toBe('');
    act(() => vi.advanceTimersByTime(50));
    expect(result.current.length).toBeGreaterThan(0);
    expect(result.current.length).toBeLessThan('Merhaba dünya'.length);
    expect('Merhaba dünya'.startsWith(result.current)).toBe(true);
    act(() => vi.advanceTimersByTime(2000));
    expect(result.current).toBe('Merhaba dünya');
  });

  it('kaydedilen mesaj akışın kaldığı yerden sürer', () => {
    const text = 'a'.repeat(200);
    const live = renderHook(() => useTypewriter(text, 'turn-2', true));
    act(() => vi.advanceTimersByTime(100));
    const reached = live.result.current.length;
    expect(reached).toBeGreaterThan(0);
    live.unmount();

    const saved = renderHook(() => useTypewriter(text, 'turn-2'));
    expect(saved.result.current.length).toBe(reached);
    act(() => vi.advanceTimersByTime(2000));
    expect(saved.result.current).toBe(text);
  });

  it('akışı görülmemiş eski mesajı hemen tümüyle gösterir', () => {
    const { result } = renderHook(() => useTypewriter('Eski yanıt', 'turn-old'));
    expect(result.current).toBe('Eski yanıt');
  });

  it('emojiyi ortadan bölmez', () => {
    const { result } = renderHook(() => useTypewriter('😀😀😀😀😀😀😀😀', 'turn-3', true));
    for (let i = 0; i < 10; i++) {
      act(() => vi.advanceTimersByTime(16));
      const last = result.current.charCodeAt(result.current.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });
});
