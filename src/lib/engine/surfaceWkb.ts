import type { Feature, FeatureCollection, Geometry } from 'geojson';
import { decodeWkb } from './geopackage';

/**
 * ISO WKB base type codes of the surface geometries {@link decodeWkb} turns into
 * a MultiPolygon/Polygon: PolyhedralSurface (15), TIN (16), Triangle (17). The
 * Z/M variants (1015-1017, 2015-2017, 3015-3017) share these `code % 1000`.
 */
const SURFACE_WKB_TYPE_CODES = new Set([15, 16, 17]);

/**
 * True when a DuckDB query failed specifically because its Spatial WKB reader
 * cannot represent a **surface** geometry (TIN / PolyhedralSurface / Triangle) —
 * the encoding GDAL emits for ESRI MultiPatch shapefiles (3D buildings), e.g.
 * `Could not parse WKB input: WKB type 'TIN Z' is not supported! (type id: 1016,
 * SRID: 0)`. Only these surfaces trigger the raw-WKB fallback, which
 * {@link decodeWkb} can decode.
 *
 * Curved geometries (CircularString, CompoundCurve, CurvePolygon, MultiCurve,
 * MultiSurface — codes 8-12) raise the same "WKB type ... is not supported"
 * template but stay undecodable, so they are deliberately excluded: routing them
 * into the fallback would silently produce an empty (all-null-geometry) layer
 * instead of failing loudly. The match therefore requires a surface type name or
 * a surface type id (15/16/17) in the message, not just the generic error shape.
 */
export function isUnsupportedSurfaceWkbError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const isUnsupportedWkb =
    lower.includes('could not parse wkb') ||
    (lower.includes('wkb type') && lower.includes('not supported'));
  if (!isUnsupportedWkb) return false;
  // Prefer the numeric type id when present (unambiguous); otherwise fall back to
  // the type name DuckDB quotes ('TIN Z', 'PolyhedralSurface Z', 'Triangle').
  const idMatch = message.match(/type id:\s*(\d+)/i);
  if (idMatch) {
    return SURFACE_WKB_TYPE_CODES.has(Number(idMatch[1]) % 1000);
  }
  // `tin` needs word boundaries so it does not match substrings like "casting";
  // `polyhedral`/`triangle` are distinctive as-is ("PolyhedralSurface" has no
  // boundary before "Surface").
  return /\btin\b|polyhedral|triangle/i.test(message);
}

/**
 * Coerce a DuckDB geometry cell to WKB bytes: a BLOB arrives as a `Uint8Array`,
 * a base64-encoded WKB string as a `string`. Returns null for an empty/absent
 * value or an undecodable base64 string.
 */
function wkbCellToBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value.length > 0 ? value : null;
  if (typeof value === 'string' && value.length > 0) {
    try {
      return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
    } catch {
      return null;
    }
  }
  return null;
}

/** Normalize a DuckDB cell into a JSON-serializable GeoJSON property value. */
function sanitizeProperty(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') {
    return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return null;
  if (typeof value === 'object') {
    try {
      return JSON.parse(
        JSON.stringify(value, (_key, v) =>
          typeof v === 'bigint'
            ? Number.isSafeInteger(Number(v))
              ? Number(v)
              : v.toString()
            : v,
        ),
      );
    } catch {
      return String(value);
    }
  }
  return value;
}

/**
 * Build a FeatureCollection from `keep_wkb := true` rows, decoding each row's raw
 * WKB with {@link decodeWkb} (which maps TIN / PolyhedralSurface surfaces to a
 * MultiPolygon). The geometry cell is accepted as either a BLOB (`Uint8Array`)
 * or a base64 WKB string. A value that cannot be decoded yields a null geometry
 * rather than aborting the whole file, and the WKB column is dropped from the
 * feature's properties.
 *
 * @param rows - Rows from a `SELECT * FROM ST_Read(..., keep_wkb := true)` query.
 * @param wkbColumn - The name of the WKB geometry column.
 */
export function wkbRowsToFeatureCollection(
  rows: Array<Record<string, unknown>>,
  wkbColumn: string,
): FeatureCollection<Geometry | null> {
  const features = rows.map((row) => {
    const bytes = wkbCellToBytes(row[wkbColumn]);
    let geometry: Geometry | null = null;
    if (bytes) {
      try {
        geometry = decodeWkb(bytes);
      } catch {
        // One malformed/unrepresentable geometry must not fail the whole layer.
        geometry = null;
      }
    }
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (key === wkbColumn || value instanceof Uint8Array) continue;
      properties[key] = sanitizeProperty(value);
    }
    return {
      type: 'Feature',
      geometry,
      properties,
    } satisfies Feature<Geometry | null>;
  });
  return { type: 'FeatureCollection', features };
}
