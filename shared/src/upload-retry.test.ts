import { describe, expect, it } from 'vitest';
import { newUploadId, retryableUpload, startUpload, uploadStatusOf, withUploadRetry } from './upload-retry';

class Failed extends Error {
  constructor(public status: number | null) {
    super(String(status));
  }
}
const statusOf = (e: unknown) => (e instanceof Failed ? e.status : undefined);
const noWait = () => Promise.resolve();

describe('yükleme yeniden denemesi', () => {
  it('bağlantı kopması ve sunucu hatası yeniden denenir; ret ve "çok istek" denenmez', () => {
    for (const s of [null, 0, 408, 500, 502, 503, 504]) expect(retryableUpload(s)).toBe(true);
    for (const s of [400, 401, 403, 404, 409, 413, 415, 425, 429]) expect(retryableUpload(s)).toBe(false);
  });

  it('uygulamaların hatalarından durumu okur', () => {
    expect(uploadStatusOf(Object.assign(new Error('x'), { status: 503 }))).toBe(503);
    expect(uploadStatusOf(Object.assign(new Error('x'), { noAnswer: true }))).toBeNull();
    expect(uploadStatusOf(new DOMException('Aborted', 'AbortError'))).toBeUndefined();
    expect(uploadStatusOf(new TypeError('okunamadı'))).toBeUndefined();
    expect(uploadStatusOf('metin')).toBeUndefined();
  });

  it('iptal edilen yükleme ne sonuç ne hata bildirir', async () => {
    const results: string[] = [];
    let release!: () => void;
    const ctrl = startUpload({
      attempt: (signal) =>
        new Promise<string>((resolve, reject) => {
          release = () => resolve('tamam');
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
      onDone: (r) => results.push(r),
      onFail: (m) => results.push(`hata: ${m}`),
    });
    ctrl.abort();
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(results).toEqual([]);

    const failed = await new Promise<string>((resolve) =>
      startUpload({
        attempt: () => Promise.reject(Object.assign(new Error('çok büyük'), { status: 413 })),
        onDone: () => resolve('beklenmedik'),
        onFail: resolve,
      }),
    );
    expect(failed).toBe('çok büyük');
  });

  it('geçici hatada bir kez daha dener ve ikinci sonucu verir', async () => {
    let n = 0;
    const r = await withUploadRetry(
      async () => {
        n++;
        if (n === 1) throw new Failed(503);
        return 'tamam';
      },
      { statusOf, wait: noWait },
    );
    expect(r).toBe('tamam');
    expect(n).toBe(2);
  });

  it('en fazla bir kez yeniden dener', async () => {
    let n = 0;
    const run = withUploadRetry(
      () => {
        n++;
        return Promise.reject(new Failed(null));
      },
      { statusOf, wait: noWait },
    );
    await expect(run).rejects.toBeInstanceOf(Failed);
    expect(n).toBe(2);
  });

  it('dosya çok büyükse ya da yükleme iptal edildiyse yeniden denemez', async () => {
    let n = 0;
    await expect(
      withUploadRetry(
        () => {
          n++;
          return Promise.reject(new Failed(413));
        },
        { statusOf, wait: noWait },
      ),
    ).rejects.toBeInstanceOf(Failed);
    expect(n).toBe(1);

    const ctrl = new AbortController();
    n = 0;
    await expect(
      withUploadRetry(
        () => {
          n++;
          ctrl.abort();
          return Promise.reject(new Failed(null));
        },
        { statusOf, wait: noWait, signal: ctrl.signal },
      ),
    ).rejects.toBeInstanceOf(Failed);
    expect(n).toBe(1);
  });

  it('isteğe ait olmayan hatayı yeniden denemez', async () => {
    let n = 0;
    await expect(
      withUploadRetry(
        () => {
          n++;
          return Promise.reject(new Error('iptal'));
        },
        { statusOf, wait: noWait },
      ),
    ).rejects.toThrow('iptal');
    expect(n).toBe(1);
  });

  it('yükleme kimliği her seferinde yeni ve sunucunun kabul ettiği biçimde', () => {
    const a = newUploadId();
    expect(a).toMatch(/^[0-9a-f]{24}$/);
    expect(newUploadId()).not.toBe(a);
  });
});
