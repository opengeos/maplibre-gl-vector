import type { FeatureCollection, GeoJSON } from 'geojson';
import { toFeatureCollection } from '../utils/geometry';

/**
 * The `type` values a top-level GeoJSON object can carry (RFC 7946).
 */
const GEOJSON_TYPES = new Set([
  'FeatureCollection',
  'Feature',
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
  'GeometryCollection',
]);

/**
 * Whether a parsed value is shaped like a GeoJSON object (a plain object
 * with a recognized `type`).
 *
 * @param value - A value parsed from JSON
 * @returns True when `value` looks like GeoJSON
 */
export function looksLikeGeoJSON(value: unknown): value is GeoJSON {
  return (
    typeof value === 'object' &&
    value !== null &&
    GEOJSON_TYPES.has((value as { type?: unknown }).type as string)
  );
}

/**
 * Fetches a remote URL and returns its parsed GeoJSON when the response
 * is GeoJSON, or `null` when it is not.
 *
 * Extensionless service endpoints (OGC API Features `?f=geojson`, ArcGIS
 * REST `query?f=geojson`, custom services with query strings and no file
 * extension) return GeoJSON the file-name detector cannot classify, so it
 * falls through to the DuckDB engine. That engine path lazily installs the
 * spatial extension from a remote repository, which hangs in sandboxed or
 * firewalled environments. Sniffing the response here keeps a GeoJSON
 * endpoint on the pure-JS path, so DuckDB is never loaded for it.
 *
 * The response body is only read when the `Content-Type` is JSON-ish, so a
 * binary endpoint without an extension (a `.parquet` behind a query string,
 * say) is not downloaded as text; its download is cancelled and the caller
 * falls back to the engine. The fetched text is returned alongside the
 * collection so the caller can render it without a second request.
 *
 * @param url - The http(s) URL to probe
 * @returns The parsed collection and its byte size, or `null` when the
 *   source is not a JSON response the caller should treat as GeoJSON
 */
export async function sniffRemoteGeoJSON(
  url: string,
): Promise<{ collection: FeatureCollection; byteSize: number } | null> {
  if (!/^https?:\/\//i.test(url)) return null;

  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    // Network/CORS failure: let the engine path attempt the load and
    // surface its own error rather than masking it here.
    return null;
  }
  if (!response.ok) return null;

  const contentType = response.headers.get('content-type') ?? '';
  if (!/json/i.test(contentType)) {
    // Not a JSON response (e.g. application/octet-stream for a parquet
    // endpoint); don't download the body as text.
    await response.body?.cancel().catch(() => undefined);
    return null;
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // JSON content type but unparsable body; fall back to the engine.
    return null;
  }

  if (!looksLikeGeoJSON(parsed)) return null;
  return { collection: toFeatureCollection(parsed), byteSize: text.length };
}
