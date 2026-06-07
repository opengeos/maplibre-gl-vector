import type { Feature } from 'geojson';
import { importFromCdn } from '../engine/duckdbLoader';

/**
 * CDN URLs for the JS tile encoder used when the loaded DuckDB build
 * lacks ST_AsMVT.
 */
const GEOJSON_VT_URL = 'https://cdn.jsdelivr.net/npm/geojson-vt@4.0.2/+esm';
const VT_PBF_URL = 'https://cdn.jsdelivr.net/npm/vt-pbf@3.1.3/+esm';

/* eslint-disable @typescript-eslint/no-explicit-any */
let encoderPromise: Promise<{ geojsonvt: any; fromGeojsonVt: any }> | undefined;

function loadEncoder() {
  if (!encoderPromise) {
    encoderPromise = Promise.all([importFromCdn(GEOJSON_VT_URL), importFromCdn(VT_PBF_URL)]).then(
      ([gvt, vtpbf]: any[]) => ({
        geojsonvt: gvt.default ?? gvt,
        fromGeojsonVt: vtpbf.fromGeojsonVt ?? vtpbf.default?.fromGeojsonVt,
      }),
    );
    encoderPromise.catch(() => {
      encoderPromise = undefined;
    });
  }
  return encoderPromise;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Computes the EPSG:4326 bounds of a slippy map tile.
 *
 * @param z - Tile zoom
 * @param x - Tile column
 * @param y - Tile row
 * @param buffer - Fractional tile buffer applied to all sides
 * @returns [west, south, east, north]
 */
export function tileBbox4326(
  z: number,
  x: number,
  y: number,
  buffer = 0,
): [number, number, number, number] {
  const n = 2 ** z;
  const lonAt = (col: number) => (col / n) * 360 - 180;
  const latAt = (row: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n))) * 180) / Math.PI;
  const west = lonAt(x - buffer);
  const east = lonAt(x + 1 + buffer);
  const north = latAt(y - buffer);
  const south = latAt(y + 1 + buffer);
  return [west, south, east, north];
}

/**
 * Encodes GeoJSON features into an MVT tile in JavaScript using
 * geojson-vt and vt-pbf (lazy-loaded from a CDN).
 *
 * Used as a fallback when the DuckDB spatial build has no ST_AsMVT.
 *
 * @param features - Features intersecting the tile (EPSG:4326)
 * @param layerName - MVT layer name (matches the map source-layer)
 * @param z - Tile zoom
 * @param x - Tile column
 * @param y - Tile row
 * @returns The encoded tile bytes (empty when no features)
 */
export async function encodeTileFromFeatures(
  features: Feature[],
  layerName: string,
  z: number,
  x: number,
  y: number,
): Promise<Uint8Array> {
  if (features.length === 0) return new Uint8Array(0);

  const { geojsonvt, fromGeojsonVt } = await loadEncoder();
  const index = geojsonvt(
    { type: 'FeatureCollection', features },
    { maxZoom: z, indexMaxZoom: z, indexMaxPoints: 0, buffer: 64, tolerance: 3 },
  );
  const tile = index.getTile(z, x, y);
  if (!tile) return new Uint8Array(0);

  const encoded = fromGeojsonVt({ [layerName]: tile }, { version: 2 });
  return new Uint8Array(encoded);
}
