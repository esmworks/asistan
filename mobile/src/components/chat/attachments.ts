import { startUpload } from '@yumakbot/shared';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { toast } from '@/components/overlay';
import { t } from '@/i18n';
import { newClientId } from '@/lib/stream';
import { useApi } from '@/lib/server';

/** The server's limits for one message's files (the same numbers as the shared schema's). */
const MAX_FILES = 20;
const MAX_BYTES = 50 * 1024 * 1024;
/** Files left in a composer are dropped well before the server's sweep would take them away. */
const KEEP_MS = 20 * 60 * 60 * 1000;

/** An upload waiting on the server for its message; sending moves it into the conversation folder. */
export interface StagedFile {
  name: string;
  size: number;
}

/** A file in the composer: uploading, or waiting on the server. */
export interface Attachment {
  key: string;
  name: string;
  /** Local picture for images, until the message is sent. */
  preview: string | null;
  saved: StagedFile | null;
  /** When it was added; the server removes uploads left unsent for a day. */
  addedAt: number;
  /** Why the upload failed; the file stays in the composer to be tried again or taken off. */
  error: string | null;
}

/** A file or photo chosen on the phone. */
export interface Picked {
  uri: string;
  name: string;
  size?: number;
  mimeType?: string;
}

const EMPTY: Attachment[] = [];
/**
 * What a file not yet on the server needs and the composer's list does not keep: the picked
 * file, for another try, the id the server knows its tries by, and the way to call it off.
 */
const uploads = new Map<string, { file: Picked; uploadId: string; ctrl: AbortController | null }>();
// Kept outside the composer so, like the typed draft, files are still there after visiting
// another conversation and coming back.
const byThread = new Map<string, Attachment[]>();
const listeners = new Set<() => void>();

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
const filesOf = (threadId: string) => byThread.get(threadId) ?? EMPTY;
function setFiles(threadId: string, change: (list: Attachment[]) => Attachment[]) {
  const list = change(filesOf(threadId));
  if (list.length) byThread.set(threadId, list);
  else byThread.delete(threadId);
  for (const fn of listeners) fn();
}

/**
 * Files attached in the composer of one conversation. Each is uploaded as soon as it is added,
 * so sending only names files already on the server.
 */
export function useAttachments(threadId: string | undefined) {
  const api = useApi();
  const items = useSyncExternalStore(subscribe, () => (threadId ? filesOf(threadId) : EMPTY));

  const discard = useCallback(
    (id: string, name: string) => void api.removeFile(id, name).catch(() => undefined),
    [api],
  );

  // Files left too long ago may already be gone from the server.
  useEffect(() => {
    if (!threadId) return;
    const old = filesOf(threadId).filter((a) => a.saved && Date.now() - a.addedAt > KEEP_MS);
    if (!old.length) return;
    for (const a of old) discard(threadId, a.saved!.name);
    setFiles(threadId, (list) => list.filter((a) => !old.includes(a)));
  }, [threadId, discard]);

  const patch = (id: string, key: string, change: Partial<Attachment>) =>
    setFiles(id, (list) => list.map((a) => (a.key === key ? { ...a, ...change } : a)));

  /** Sends one file up, once more on a passing failure; a failure leaves it in the composer. */
  const upload = (id: string, key: string) => {
    const u = uploads.get(key);
    if (!u) return;
    patch(id, key, { error: null });
    u.ctrl = startUpload({
      attempt: (signal) =>
        api.uploadFile(id, { uri: u.file.uri, name: u.file.name }, { uploadId: u.uploadId, signal }),
      onDone: (saved) => {
        uploads.delete(key);
        // Taken off while it was uploading.
        if (!filesOf(id).some((a) => a.key === key)) return discard(id, saved.name);
        patch(id, key, { saved, name: saved.name, addedAt: Date.now() });
      },
      onFail: (message) => {
        // Taken off already: nothing left to undo.
        if (!filesOf(id).some((a) => a.key === key)) return;
        u.ctrl = null;
        patch(id, key, { error: message });
        toast(t('chat.uploadFailed', { name: u.file.name, error: message }), { tone: 'error' });
      },
    });
  };

  const add = (files: Picked[]) => {
    if (!threadId) return;
    const room = MAX_FILES - filesOf(threadId).length;
    if (files.length > room) toast(t('chat.tooManyFiles', { max: MAX_FILES }), { tone: 'error' });
    for (const file of files.slice(0, Math.max(room, 0))) {
      if (file.size !== undefined && file.size > MAX_BYTES) {
        toast(t('chat.fileTooLarge', { name: file.name, max: MAX_BYTES / 1024 / 1024 }), { tone: 'error' });
        continue;
      }
      const key = newClientId();
      const image = file.mimeType?.startsWith('image/') ?? false;
      const item: Attachment = {
        key,
        name: file.name,
        preview: image ? file.uri : null,
        saved: null,
        addedAt: Date.now(),
        error: null,
      };
      setFiles(threadId, (list) => [...list, item]);
      uploads.set(key, { file, uploadId: newClientId(), ctrl: null });
      upload(threadId, key);
    }
  };

  /** Tries a failed file again, under the same upload id. */
  const retry = (a: Attachment) => {
    if (!threadId || a.saved || !a.error) return;
    upload(threadId, a.key);
  };

  const remove = (a: Attachment) => {
    if (!threadId) return;
    setFiles(threadId, (list) => list.filter((x) => x.key !== a.key));
    if (a.saved) return discard(threadId, a.saved.name);
    // Not on the server yet: called off. Its upload may get through all the same (it was all
    // sent and only the answer is missing); the server removes it then, by its upload id.
    const u = uploads.get(a.key);
    if (!u) return;
    uploads.delete(a.key);
    u.ctrl?.abort();
    void api.cancelUpload(threadId, u.uploadId).catch(() => undefined);
  };

  /** Hands the uploaded files to a message and empties the composer. */
  const take = (): StagedFile[] => {
    if (!threadId) return [];
    const list = filesOf(threadId);
    for (const a of list) uploads.delete(a.key);
    setFiles(threadId, () => EMPTY);
    return list.flatMap((a) => (a.saved ? [a.saved] : []));
  };

  /** Puts files back after a failed send; they are still on the server. */
  const restore = (files: StagedFile[]) => {
    if (!threadId) return;
    const now = Date.now();
    setFiles(threadId, (list) => [
      ...files.map((f) => ({
        key: newClientId(),
        name: f.name,
        preview: null,
        saved: f,
        addedAt: now,
        error: null,
      })),
      ...list,
    ]);
  };

  // A file that failed counts as not there yet: the message waits until it is tried again or taken off.
  return { items, uploading: items.some((a) => !a.saved), add, remove, retry, take, restore };
}
