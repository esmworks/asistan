/**
 * An attached file that fails to go up is tried once more on its own when the failure looks
 * passing (the connection dropped, the server was restarting or failed), so a short hiccup does
 * not cost the person their file. A refusal (too large, no access, archived bot) is not tried
 * again, and neither is "too many requests": a second try a moment later would be refused too,
 * so that one waits for the person's own "try again".
 */

/** How long to wait before the second try. */
export const UPLOAD_RETRY_DELAY_MS = 1500;

/**
 * Whether a failed upload is worth trying again: `null` is a request that got no answer at all
 * (the connection dropped), otherwise the HTTP status the server answered with.
 */
export function retryableUpload(status: number | null): boolean {
  if (status === null || status === 0) return true;
  return status === 408 || status >= 500;
}

/**
 * The HTTP status of a failed upload, read from the apps' own errors: their API error carries
 * `status`, the error for a request that got no answer carries `noAnswer` (null then). Anything
 * else, such as a cancelled upload, is undefined: not about the request.
 */
export function uploadStatusOf(err: unknown): number | null | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  if ((err as { noAnswer?: unknown }).noAnswer === true) return null;
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * Runs `attempt` and, when it fails in a way {@link retryableUpload} accepts, once more after a
 * short wait. The same `attempt` runs both times, so it should carry an upload id that lets the
 * server recognise a repeat.
 */
export async function withUploadRetry<T>(
  attempt: () => Promise<T>,
  opts: {
    statusOf?: (err: unknown) => number | null | undefined;
    signal?: AbortSignal;
    wait?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  try {
    return await attempt();
  } catch (err) {
    const status = (opts.statusOf ?? uploadStatusOf)(err);
    if (status === undefined || opts.signal?.aborted || !retryableUpload(status)) throw err;
    await (opts.wait ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(UPLOAD_RETRY_DELAY_MS);
    if (opts.signal?.aborted) throw err;
    return attempt();
  }
}

/**
 * One attached file going up, as both apps run it: tried once more on a passing failure, called
 * off with the controller it returns. `onDone` gets the server's answer; `onFail` the reason, and
 * neither is called once the upload has been called off.
 */
export function startUpload<T>(opts: {
  attempt: (signal: AbortSignal) => Promise<T>;
  onDone: (result: T) => void;
  onFail: (message: string) => void;
  wait?: (ms: number) => Promise<void>;
}): AbortController {
  const ctrl = new AbortController();
  withUploadRetry(() => opts.attempt(ctrl.signal), { signal: ctrl.signal, wait: opts.wait }).then(
    (result) => opts.onDone(result),
    (err: unknown) => {
      if (!ctrl.signal.aborted) opts.onFail(err instanceof Error ? err.message : String(err));
    },
  );
  return ctrl;
}

/** A fresh id for one attached file, kept across its tries. */
export function newUploadId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
