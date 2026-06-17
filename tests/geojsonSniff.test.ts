import { describe, it, expect, vi, afterEach } from 'vitest';
import { looksLikeGeoJSON, sniffRemoteGeoJSON } from '../src/lib/formats/geojsonSniff';

afterEach(() => {
  vi.unstubAllGlobals();
});

const FC = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: {} },
  ],
};

/** Builds a Response-like stub for fetch with a controllable body/content-type. */
function jsonResponse(body: string, contentType = 'application/geo+json') {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    text: vi.fn(async () => body),
    body: { cancel: vi.fn(async () => undefined) },
  };
}

describe('looksLikeGeoJSON', () => {
  it('accepts the GeoJSON top-level types', () => {
    expect(looksLikeGeoJSON({ type: 'FeatureCollection', features: [] })).toBe(true);
    expect(looksLikeGeoJSON({ type: 'Feature', geometry: null, properties: {} })).toBe(true);
    expect(looksLikeGeoJSON({ type: 'Point', coordinates: [0, 0] })).toBe(true);
  });

  it('rejects non-GeoJSON values', () => {
    expect(looksLikeGeoJSON({ type: 'Topology' })).toBe(false);
    expect(looksLikeGeoJSON({ foo: 'bar' })).toBe(false);
    expect(looksLikeGeoJSON('FeatureCollection')).toBe(false);
    expect(looksLikeGeoJSON(null)).toBe(false);
    expect(looksLikeGeoJSON([])).toBe(false);
  });
});

describe('sniffRemoteGeoJSON', () => {
  it('returns the collection for a JSON-typed GeoJSON response', async () => {
    const body = JSON.stringify(FC);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(body)));
    const result = await sniffRemoteGeoJSON('https://api.example.com/collections/x/items?f=geojson');
    expect(result?.collection.features).toHaveLength(1);
    expect(result?.byteSize).toBe(body.length);
  });

  it('wraps a bare geometry/Feature into a FeatureCollection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(JSON.stringify({ type: 'Point', coordinates: [3, 4] }))),
    );
    const result = await sniffRemoteGeoJSON('https://api.example.com/point');
    expect(result?.collection.type).toBe('FeatureCollection');
    expect(result?.collection.features).toHaveLength(1);
  });

  it('returns null and cancels the body for a non-JSON content type', async () => {
    const response = jsonResponse('PAR1binary', 'application/octet-stream');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    const result = await sniffRemoteGeoJSON('https://example.com/data?format=parquet');
    expect(result).toBeNull();
    // The body download is cancelled rather than read as text.
    expect(response.body.cancel).toHaveBeenCalled();
    expect(response.text).not.toHaveBeenCalled();
  });

  it('returns null for JSON that is not GeoJSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(JSON.stringify({ hello: 'world' }))));
    expect(await sniffRemoteGeoJSON('https://api.example.com/meta')).toBeNull();
  });

  it('returns null for an unparsable JSON body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse('{not json', 'application/json')));
    expect(await sniffRemoteGeoJSON('https://api.example.com/broken')).toBeNull();
  });

  it('returns null on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    expect(await sniffRemoteGeoJSON('https://api.example.com/down')).toBeNull();
  });

  it('returns null when fetch throws (network/CORS)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('blocked')));
    expect(await sniffRemoteGeoJSON('https://api.example.com/blocked')).toBeNull();
  });

  it('ignores non-http sources', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await sniffRemoteGeoJSON('data:application/json,{}')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
