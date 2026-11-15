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
}

/** A file or photo chosen on the phone. */
export interface Picked {
  uri: string;
  name: string;
  size?: number;
  mimeType?: string;
}

const EMPTY: Attachment[] = [];
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
      };
      setFiles(threadId, (list) => [...list, item]);
      api.uploadFile(threadId, { uri: file.uri, name: file.name }).then(
        (saved) => {
          // Taken off while it was uploading.
          if (!filesOf(threadId).some((a) => a.key === key)) return discard(threadId, saved.name);
          setFiles(threadId, (list) =>
            list.map((a) => (a.key === key ? { ...a, saved, name: saved.name, addedAt: Date.now() } : a)),
          );
        },
        (e: Error) => {
          // Taken off already: nothing left to undo.
          if (!filesOf(threadId).some((a) => a.key === key)) return;
          setFiles(threadId, (list) => list.filter((a) => a.key !== key));
          toast(t('chat.uploadFailed', { name: file.name, error: e.message }), { tone: 'error' });
        },
      );
    }
  };

  const remove = (a: Attachment) => {
    if (!threadId) return;
    setFiles(threadId, (list) => list.filter((x) => x.key !== a.key));
    // Still uploading: removed from the server once the upload ends.
    if (a.saved) discard(threadId, a.saved.name);
  };

  /** Hands the uploaded files to a message and empties the composer. */
  const take = (): StagedFile[] => {
    if (!threadId) return [];
    const list = filesOf(threadId);
    setFiles(threadId, () => EMPTY);
    return list.flatMap((a) => (a.saved ? [a.saved] : []));
  };

  /** Puts files back after a failed send; they are still on the server. */
  const restore = (files: StagedFile[]) => {
    if (!threadId) return;
    const now = Date.now();
    setFiles(threadId, (list) => [
      ...files.map((f) => ({ key: newClientId(), name: f.name, preview: null, saved: f, addedAt: now })),
      ...list,
    ]);
  };

  return { items, uploading: items.some((a) => !a.saved), add, remove, take, restore };
}
