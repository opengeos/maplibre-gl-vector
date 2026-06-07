import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  hasTileProvider,
  loadTile,
  parseTileUrl,
  registerTileProvider,
  tileUrlFor,
  unregisterTileProvider,
} from '../src/lib/tiles/protocol';
import { tileBbox4326 } from '../src/lib/tiles/mvtFallback';

afterEach(() => {
  // Clean up any providers registered by a test.
  for (const id of ['a', 'b', 'layer-1']) {
    unregisterTileProvider(id);
  }
});

describe('tileUrlFor', () => {
  it('builds the duckdb:// template', () => {
    expect(tileUrlFor('layer-1')).toBe('duckdb://layer-1/{z}/{x}/{y}');
  });
});

describe('parseTileUrl', () => {
  it('parses z/x/y URLs', () => {
    expect(parseTileUrl('duckdb://layer-1/3/2/1')).toEqual({
      providerKey: 'layer-1',
      z: 3,
      x: 2,
      y: 1,
    });
  });

  it('accepts a .pbf suffix', () => {
    expect(parseTileUrl('duckdb://layer-1/3/2/1.pbf')).toEqual({
      providerKey: 'layer-1',
      z: 3,
      x: 2,
      y: 1,
    });
  });

  it('round-trips keys with reserved characters', () => {
    const url = tileUrlFor('weird/key with spaces').replace('{z}/{x}/{y}', '1/2/3');
    expect(parseTileUrl(url)).toEqual({
      providerKey: 'weird/key with spaces',
      z: 1,
      x: 2,
      y: 3,
    });
  });

  it('rejects malformed URLs', () => {
    expect(parseTileUrl('duckdb://layer-1/3/2')).toBeNull();
    expect(parseTileUrl('https://x.com/3/2/1')).toBeNull();
    expect(parseTileUrl('duckdb://layer-1/a/b/c')).toBeNull();
  });
});

describe('provider registry', () => {
  it('routes tile loads to the registered provider', async () => {
    const provider = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    await registerTileProvider('a', provider);

    const data = await loadTile('duckdb://a/4/5/6', new AbortController().signal);
    expect(data).toEqual(new Uint8Array([1, 2, 3]));
    expect(provider).toHaveBeenCalledWith(4, 5, 6, expect.any(AbortSignal));
  });

  it('returns an empty tile for unknown layers', async () => {
    const data = await loadTile('duckdb://missing/0/0/0', new AbortController().signal);
    expect(data).toEqual(new Uint8Array(0));
  });

  it('throws on invalid URLs', async () => {
    await expect(loadTile('duckdb://broken', new AbortController().signal)).rejects.toThrow(
      /Invalid duckdb:\/\//,
    );
  });

  it('tracks registration state', async () => {
    expect(hasTileProvider('b')).toBe(false);
    await registerTileProvider('b', vi.fn());
    expect(hasTileProvider('b')).toBe(true);
    unregisterTileProvider('b');
    expect(hasTileProvider('b')).toBe(false);
  });
});

describe('tileBbox4326', () => {
  it('covers the world at z0', () => {
    const [w, s, e, n] = tileBbox4326(0, 0, 0);
    expect(w).toBeCloseTo(-180);
    expect(e).toBeCloseTo(180);
    expect(s).toBeCloseTo(-85.0511, 3);
    expect(n).toBeCloseTo(85.0511, 3);
  });

  it('splits the world at z1', () => {
    const [w, s, e, n] = tileBbox4326(1, 0, 0);
    expect(w).toBeCloseTo(-180);
    expect(e).toBeCloseTo(0);
    expect(n).toBeCloseTo(85.0511, 3);
    expect(s).toBeCloseTo(0);
  });

  it('expands with a buffer', () => {
    const plain = tileBbox4326(2, 1, 1);
    const buffered = tileBbox4326(2, 1, 1, 0.1);
    expect(buffered[0]).toBeLessThan(plain[0]);
    expect(buffered[2]).toBeGreaterThan(plain[2]);
  });
});
