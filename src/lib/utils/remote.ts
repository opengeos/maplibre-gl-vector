/**
 * Remote file size probing.
 *
 * DuckDB-WASM's HTTP filesystem handles remote file sizes as 32-bit
 * values; files of 2 GiB or larger fail to open with an opaque
 * "Cannot read properties of null (reading 'byteLength')" error.
 * Probing the size up front (before the ~20 MB engine download even
 * starts) turns that into an immediate, actionable message.
 */

/**
 * Largest remote file DuckDB-WASM can open.
 */
export const MAX_REMOTE_FILE_BYTES = 2 ** 31 - 1;

const sizes = new Map<string, number | undefined>();

/**
 * Returns the remote file size from a HEAD request, cached per URL.
 *
 * @param url - The http(s) URL to probe
 * @returns The content length in bytes, or undefined when the HEAD is
 *   blocked or reports no length
 */
export async function probeRemoteSize(url: string): Promise<number | undefined> {
  if (!/^https?:\/\//i.test(url)) return undefined;
  if (!sizes.has(url)) {
    let size: number | undefined;
    try {
      const response = await fetch(url, { method: 'HEAD' });
      const length = response.headers.get('content-length');
      if (length) size = Number(length);
    } catch {
      // HEAD unavailable (CORS or method blocked); let DuckDB try.
    }
    sizes.set(url, size);
  }
  return sizes.get(url);
}

/**
 * Probes a remote file's size and rejects files DuckDB-WASM cannot
 * open (2 GiB or larger).
 *
 * @param url - The http(s) URL to check
 * @returns The content length in bytes, when known
 * @throws Error with an actionable message for oversized files
 */
export async function assertRemoteFileSupported(url: string): Promise<number | undefined> {
  const size = await probeRemoteSize(url);
  if (size !== undefined && size > MAX_REMOTE_FILE_BYTES) {
    const gib = (size / 1024 ** 3).toFixed(2);
    throw new Error(
      `This file is ${gib} GiB; DuckDB-WASM cannot open remote files of 2 GiB or larger. ` +
        `Use a smaller file or partition (e.g. split by region).`,
    );
  }
  return size;
}
