/**
 * Reading a GeoParquet file's declared CRS out of its `geo` file metadata.
 *
 * Every other format this engine ingests goes through GDAL's `ST_Read`, whose
 * `ST_Read_Meta` reports the layer CRS, so the geometry can be reprojected to
 * WGS84 on the way in. GeoParquet is read with `read_parquet` instead, and
 * DuckDB surfaces nothing about that file's CRS in the scan, so a file stored in
 * a projected CRS used to ingest as raw eastings/northings unless the caller
 * passed `sourceCrs` by hand.
 *
 * The CRS is not lost, though: the GeoParquet specification puts it in the
 * Parquet file-level key/value metadata under the key `geo`, which DuckDB does
 * expose through `parquet_kv_metadata`. This module parses that document; the
 * query that fetches it is `geoParquetCrsQuery` in `engine/sql.ts`.
 */

/**
 * The CRS to reproject a GeoParquet source from, parsed from its `geo` metadata
 * document, or null when it needs no reprojection.
 *
 * Null covers every "already in GeoJSON's coordinate convention" case, which the
 * specification spells three ways: an absent `crs` member (GeoParquet defaults
 * to OGC:CRS84), an explicit WGS84/CRS84 identifier, and `"crs": null`, which
 * declares that the coordinates are in no known CRS at all -- reprojecting those
 * would invent an answer, so they pass through untouched.
 *
 * A CRS that is present and not WGS84 is returned in the most specific form the
 * document supports, in this order:
 *
 * 1. `AUTHORITY:CODE` from the PROJJSON `id` member (`EPSG:2100`), which every
 *    writer that round-trips an EPSG code emits and which `ST_Transform`
 *    resolves most reliably.
 * 2. The PROJJSON document itself, for a CRS carrying no authority code (a
 *    custom projection); PROJ parses PROJJSON wherever it parses WKT.
 * 3. The raw string, for the pre-1.0 GeoParquet drafts that wrote the CRS as a
 *    WKT2 string rather than as PROJJSON.
 *
 * @param metadataJson - The `geo` metadata document text, or null when absent
 * @param isWgs84 - Predicate telling whether an `AUTHORITY:CODE` is WGS84 lon/lat
 * @returns A CRS string `ST_Transform` accepts, or null to skip reprojection
 */
export function geoParquetSourceCrs(
  metadataJson: string | null | undefined,
  isWgs84: (crs: string) => boolean,
): string | null {
  if (!metadataJson) return null;

  let metadata: unknown;
  try {
    metadata = JSON.parse(metadataJson);
  } catch {
    // A `geo` key that is not JSON is not a GeoParquet document; treat the file
    // as carrying no CRS rather than failing the ingest.
    return null;
  }

  const column = primaryGeometryColumn(metadata);
  if (!column || !("crs" in column)) return null;

  const crs = (column as { crs?: unknown }).crs;
  // An explicit null declares "no CRS", distinct from an absent member (CRS84).
  if (crs === null || crs === undefined) return null;

  const resolved = crsString(crs);
  if (!resolved || isWgs84(resolved)) return null;
  return resolved;
}

/**
 * The metadata entry for the file's primary geometry column, falling back to the
 * first column listed when `primary_column` names one that is absent (or is
 * missing itself), so a hand-written document with a single geometry column
 * still resolves.
 *
 * @param metadata - The parsed `geo` document
 * @returns The column's metadata object, or null when there is none
 */
function primaryGeometryColumn(metadata: unknown): object | null {
  const columns = (metadata as { columns?: unknown })?.columns;
  if (!columns || typeof columns !== "object") return null;
  const entries = Object.entries(columns as Record<string, unknown>).filter(
    (entry): entry is [string, object] =>
      typeof entry[1] === "object" && entry[1] !== null,
  );
  if (entries.length === 0) return null;

  const primary = (metadata as { primary_column?: unknown }).primary_column;
  if (typeof primary === "string") {
    const named = entries.find(([name]) => name === primary);
    if (named) return named[1];
  }
  return entries[0][1];
}

/**
 * One column's `crs` value rendered as a string `ST_Transform` accepts.
 *
 * @param crs - The `crs` member: PROJJSON, a WKT string, or something else
 * @returns The CRS as a string, or null when the value carries none
 */
function crsString(crs: unknown): string | null {
  if (typeof crs === "string") return crs.trim() || null;
  if (typeof crs !== "object") return null;

  const id = (crs as { id?: unknown }).id;
  const authority = (id as { authority?: unknown })?.authority;
  const code = (id as { code?: unknown })?.code;
  if (
    typeof authority === "string" &&
    (typeof code === "string" || typeof code === "number")
  ) {
    return `${authority.trim().toUpperCase()}:${String(code).trim()}`;
  }

  // No authority code: hand PROJ the whole PROJJSON definition instead, so a
  // custom projection still reprojects rather than ingesting as raw coordinates.
  return JSON.stringify(crs);
}
