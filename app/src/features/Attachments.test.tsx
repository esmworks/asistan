import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { useAttachments } from './Attachments';

vi.mock('@/lib/api', () => ({
  api: { uploadFile: vi.fn(), cancelUpload: vi.fn(), removeFile: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const uploadFile = vi.mocked(api.uploadFile);
const cancelUpload = vi.mocked(api.cancelUpload);
const removeFile = vi.mocked(api.removeFile);

/** A refusal is not tried again on its own, so the chip fails at once. */
const refused = () => Promise.reject(Object.assign(new Error('çok büyük'), { status: 413 }));
const file = (name = 'not.txt') => new File(['merhaba'], name, { type: 'text/plain' });

describe('mesaj kutusundaki ekler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cancelUpload.mockResolvedValue(undefined as never);
    removeFile.mockResolvedValue(undefined as never);
  });

  it('yüklenemeyen ek gönderimi bekletir, yeniden denenince aynı kimlikle gider', async () => {
    uploadFile.mockImplementationOnce(refused);
    const { result } = renderHook(() => useAttachments('sohbet-yeniden'));
    act(() => result.current.add([file()]));
    await waitFor(() => expect(result.current.items[0]?.error).toBe('çok büyük'));
    expect(result.current.uploading).toBe(true);

    uploadFile.mockResolvedValueOnce({ name: 'not.txt', size: 7 });
    act(() => result.current.retry(result.current.items[0]!));
    await waitFor(() => expect(result.current.items[0]?.saved).toEqual({ name: 'not.txt', size: 7 }));
    expect(result.current.items[0]?.error).toBeNull();
    expect(result.current.uploading).toBe(false);
    const ids = uploadFile.mock.calls.map((c) => c[2]?.uploadId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(result.current.take()).toEqual([{ name: 'not.txt', size: 7 }]);
  });

  it('yüklenemeyen ek kaldırılınca sunucuya kimliğiyle iptal gider', async () => {
    uploadFile.mockImplementationOnce(refused);
    const { result } = renderHook(() => useAttachments('sohbet-kaldir'));
    act(() => result.current.add([file()]));
    await waitFor(() => expect(result.current.items[0]?.error).not.toBeNull());
    const id = uploadFile.mock.calls[0]![2]?.uploadId;

    act(() => result.current.remove(result.current.items[0]!));
    expect(result.current.items).toEqual([]);
    expect(cancelUpload).toHaveBeenCalledWith('sohbet-kaldir', id, { keepalive: false });
    expect(removeFile).not.toHaveBeenCalled();
  });

  it('yüklenirken kaldırılan ek durdurulur; geç gelen cevap eki geri getirmez', async () => {
    let finish!: (v: { name: string; size: number }) => void;
    let signal: AbortSignal | undefined;
    uploadFile.mockImplementationOnce((_t, _f, opts) => {
      signal = opts?.signal;
      return new Promise((resolve) => (finish = resolve));
    });
    const { result } = renderHook(() => useAttachments('sohbet-yarida'));
    act(() => result.current.add([file()]));
    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(1));

    act(() => result.current.remove(result.current.items[0]!));
    expect(signal?.aborted).toBe(true);
    expect(cancelUpload).toHaveBeenCalledTimes(1);

    await act(async () => finish({ name: 'not.txt', size: 7 }));
    expect(result.current.items).toEqual([]);
  });

  it('kaydedilmiş ek kaldırılınca dosyası silinir', async () => {
    uploadFile.mockResolvedValueOnce({ name: 'rapor.txt', size: 7 });
    const { result } = renderHook(() => useAttachments('sohbet-kayitli'));
    act(() => result.current.add([file('rapor.txt')]));
    await waitFor(() => expect(result.current.items[0]?.saved).not.toBeNull());

    act(() => result.current.remove(result.current.items[0]!));
    expect(removeFile).toHaveBeenCalledWith('sohbet-kayitli', 'rapor.txt', { keepalive: false });
    expect(cancelUpload).not.toHaveBeenCalled();
  });
});
