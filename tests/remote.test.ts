import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  MAX_REMOTE_FILE_BYTES,
  assertRemoteFileSupported,
  probeRemoteSize,
} from '../src/lib/utils/remote';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubHead(contentLength: string | null) {
  const fetchMock = vi.fn().mockResolvedValue({
    headers: { get: (name: string) => (name === 'content-length' ? contentLength : null) },
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('probeRemoteSize', () => {
  it('returns the content length from a HEAD request', async () => {
    const fetchMock = stubHead('12345');
    await expect(probeRemoteSize('https://x.com/a.parquet')).resolves.toBe(12345);
    expect(fetchMock).toHaveBeenCalledWith('https://x.com/a.parquet', { method: 'HEAD' });
  });

  it('caches per URL', async () => {
    const fetchMock = stubHead('1');
    await probeRemoteSize('https://x.com/cached.parquet');
    await probeRemoteSize('https://x.com/cached.parquet');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ignores non-http sources', async () => {
    const fetchMock = stubHead('1');
    await expect(probeRemoteSize('local.parquet')).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns undefined when HEAD is blocked', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('CORS')));
    await expect(probeRemoteSize('https://x.com/blocked.parquet')).resolves.toBeUndefined();
  });
});

describe('assertRemoteFileSupported', () => {
  it('passes files under the limit', async () => {
    stubHead(String(MAX_REMOTE_FILE_BYTES));
    await expect(assertRemoteFileSupported('https://x.com/ok.parquet')).resolves.toBe(
      MAX_REMOTE_FILE_BYTES,
    );
  });

  it('rejects files of 2 GiB or larger with an actionable message', async () => {
    stubHead(String(2_693_467_592));
    await expect(assertRemoteFileSupported('https://x.com/huge.parquet')).rejects.toThrow(
      /2\.51 GiB.*2 GiB or larger/,
    );
  });

  it('lets unknown sizes through', async () => {
    stubHead(null);
    await expect(
      assertRemoteFileSupported('https://x.com/nolength.parquet'),
    ).resolves.toBeUndefined();
  });
});
