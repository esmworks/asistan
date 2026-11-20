/** A body was larger than the caller takes. */
export class BodyTooLarge extends Error {
  constructor(readonly max: number) {
    super(`body over ${max} bytes`);
  }
}

/**
 * A response body, read no further than `max` bytes. A size header can be missing or wrong, so the
 * bytes are counted as they arrive and the stream is let go once there are too many; a body that
 * never ends cannot fill this server's memory.
 */
export async function readCapped(
  body: AsyncIterable<Uint8Array> | null | undefined,
  max: number,
): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  // Leaving the loop early cancels the stream (and closes its connection).
  for await (const chunk of body) {
    size += chunk.length;
    if (size > max) throw new BodyTooLarge(max);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** The first `max` bytes of a response body, or all of it when shorter; the rest is not read. */
export async function readStart(
  body: AsyncIterable<Uint8Array> | null | undefined,
  max: number,
): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    chunks.push(chunk);
    size += chunk.length;
    if (size >= max) break;
  }
  return Buffer.concat(chunks).subarray(0, max);
}
