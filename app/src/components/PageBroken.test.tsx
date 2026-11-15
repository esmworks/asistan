import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';
import { PageBroken } from './PageBroken';

function Broken(): never {
  throw new Error('çizilemedi');
}

describe('sayfa hata sınırı', () => {
  afterEach(() => vi.restoreAllMocks());

  it('çöken bir parça yerine sayfayı yeniden yükleme düğmesini gösterir', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const box = document.createElement('div');
    document.body.append(box);
    const root = createRoot(box);
    await act(async () => {
      root.render(
        <ErrorBoundary fallback={<PageBroken />}>
          <Broken />
        </ErrorBoundary>,
      );
    });
    expect(box.querySelector('[role="alert"]')).not.toBeNull();
    expect(box.querySelector('button')).not.toBeNull();
    act(() => root.unmount());
    box.remove();
  });
});
