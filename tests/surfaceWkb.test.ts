import { describe, expect, it } from 'vitest';
import {
  isUnsupportedSurfaceWkbError,
  wkbRowsToFeatureCollection,
} from '../src/lib/engine/surfaceWkb';

/** Little-endian WKB for POINT(x y). */
function wkbPoint(x: number, y: number): Uint8Array {
  const bytes = new Uint8Array(1 + 4 + 16);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 1);
  view.setUint32(1, 1, true); // Point
  view.setFloat64(5, x, true);
  view.setFloat64(13, y, true);
  return bytes;
}

describe('isUnsupportedSurfaceWkbError', () => {
  it('matches TIN / PolyhedralSurface / Triangle by type id', () => {
    for (const id of [1016, 1015, 1017, 16, 2015, 3017]) {
      const error = new Error(
        `Could not parse WKB input: WKB type 'Surface' is not supported! (type id: ${id}, SRID: 0)`,
      );
      expect(isUnsupportedSurfaceWkbError(error)).toBe(true);
    }
  });

  it('matches by surface type name when no id is present', () => {
    for (const name of ['TIN Z', 'PolyhedralSurface', 'Triangle']) {
      expect(
        isUnsupportedSurfaceWkbError(
          new Error(`WKB type '${name}' is not supported!`),
        ),
      ).toBe(true);
    }
  });

  it('does not match curved geometries (codes 8-12)', () => {
    for (const id of [8, 9, 10, 11, 12]) {
      const error = new Error(
        `Could not parse WKB input: WKB type 'CircularString' is not supported! (type id: ${id}, SRID: 0)`,
      );
      expect(isUnsupportedSurfaceWkbError(error)).toBe(false);
    }
    expect(
      isUnsupportedSurfaceWkbError(
        new Error("WKB type 'CircularString' is not supported!"),
      ),
    ).toBe(false);
  });

  it('ignores unrelated errors', () => {
    expect(isUnsupportedSurfaceWkbError(new Error('stoi: no conversion'))).toBe(
      false,
    );
    expect(isUnsupportedSurfaceWkbError('TIN')).toBe(false);
  });
});

describe('wkbRowsToFeatureCollection', () => {
  it('decodes a BLOB (Uint8Array) geometry cell and drops it from properties', () => {
    const out = wkbRowsToFeatureCollection(
      [{ name: 'a', wkb_geometry: wkbPoint(3, 4) }],
      'wkb_geometry',
    );
    expect(out.features[0].geometry).toEqual({
      type: 'Point',
      coordinates: [3, 4],
    });
    expect(out.features[0].properties).toEqual({ name: 'a' });
  });

  it('decodes a base64-encoded WKB string cell', () => {
    const base64 = Buffer.from(wkbPoint(5, 6)).toString('base64');
    const out = wkbRowsToFeatureCollection(
      [{ wkb_geometry: base64 }],
      'wkb_geometry',
    );
    expect(out.features[0].geometry).toEqual({
      type: 'Point',
      coordinates: [5, 6],
    });
  });

  it('yields a null geometry for an undecodable or empty cell', () => {
    const out = wkbRowsToFeatureCollection(
      [
        { id: 1, wkb_geometry: new Uint8Array([0x01, 0x08, 0x00, 0x00, 0x00]) },
        { id: 2, wkb_geometry: null },
      ],
      'wkb_geometry',
    );
    expect(out.features[0].geometry).toBeNull();
    expect(out.features[0].properties).toEqual({ id: 1 });
    expect(out.features[1].geometry).toBeNull();
  });

  it('normalizes BigInt and drops binary property columns', () => {
    const out = wkbRowsToFeatureCollection(
      [{ count: 42n, blob: new Uint8Array([1, 2]), wkb_geometry: wkbPoint(0, 0) }],
      'wkb_geometry',
    );
    expect(out.features[0].properties).toEqual({ count: 42 });
  });
});
