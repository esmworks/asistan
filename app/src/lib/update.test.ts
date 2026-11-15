import { afterEach, describe, expect, it, vi } from 'vitest';

describe('yeni sürüm', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('aynı sürüm sayfayı yenilemez; farklı sürüm kısa bir bildirimden sonra yeniler', async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    const toast = vi.fn();
    vi.doMock('sonner', () => ({ toast }));
    const { serverBuild } = await import('./update');
    serverBuild('a1');
    serverBuild('a1');
    vi.advanceTimersByTime(10_000);
    expect(reload).not.toHaveBeenCalled();
    serverBuild('b2');
    expect(toast).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3_000);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
