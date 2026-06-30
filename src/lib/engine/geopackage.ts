import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import {
  loadSqlJs,
  looksLikeSqlite,
  quoteIdentifier,
  tableExists,
  type SqlJsDatabase,
  type SqlJsStatic,
} from "./gpkgOgrContents";

/**
 * Reads GeoPackages with sql.js (SQLite/WASM) instead of DuckDB's `ST_Read`.
 *
 * GDAL's GeoPackage driver opens the file through the SQLite VFS and, on the
 * single-threaded DuckDB-WASM build a browser loads (no cross-origin isolation,
 * so no pthread support), the read either crashes with
 * "thread constructor failed: Resource temporarily unavailable" or hangs
 * indefinitely probing for `-journal`/`-wal` sidecar files that the registered
 * in-memory file has no real directory for. Repairing `gpkg_ogr_contents` (see
 * `gpkgOgrContents.ts`) keeps GDAL on its single-threaded path for the
 * feature-count crash, but does not fix the hang, and no DuckDB-reachable GDAL
 * config disables it. Reading the SQLite tables directly with sql.js sidesteps
 * GDAL entirely: a GeoPackage geometry blob is a thin "GP" header over standard
 * WKB, and {@link decodeWkb} turns that WKB into GeoJSON. The caller then loads
 * the resulting GeoJSON through DuckDB (whose GeoJSON reader is unaffected) and
 * reprojects with `ST_Transform` when the layer is not already WGS84.
 *
 * See https://github.com/opengeos/GeoLibre/issues/1013 and #258.
 */

/** A selected feature layer plus the metadata needed to read its rows. */
interface GeoPackageLayer {
  table: string;
  geometryColumn: string;
  srsId: number | null;
  /** The INTEGER PRIMARY KEY column, excluded from feature properties. */
  idColumn: string | null;
}

export interface GeoPackageReadResult {
  featureCollection: FeatureCollection<Geometry | null>;
  /**
   * The EPSG code the geometries are stored in, or null when they are already
   * WGS84 lon/lat (or the CRS is undefined). The caller reprojects when set.
   */
  epsgCode: number | null;
}

// Envelope byte sizes by GeoPackage envelope indicator: 0=none, 1=XY, 2=XYZ,
// 3=XYM, 4=XYZM. Indicators 5-7 are reserved/invalid (OGC 12-128r18, Table 1).
const ENVELOPE_BYTES = [0, 32, 48, 48, 64];

/**
 * Strips the GeoPackage geometry-blob header, returning the standard WKB inside.
 *
 * The header is the "GP" magic, a version byte, a flags byte, a 4-byte srs_id,
 * and an optional envelope whose size is encoded in flag bits 1-3. A blob that
 * is already bare WKB (first byte a 0x00/0x01 byte-order marker) is returned
 * unchanged so non-conformant producers still read. A blob that claims the "GP"
 * magic but is truncated or carries a reserved envelope indicator throws, so a
 * malformed geometry surfaces as an explicit error instead of decoding from the
 * wrong offset into a silently wrong (or null) geometry.
 *
 * @param blob - The raw GeoPackage geometry blob.
 * @returns The standalone WKB bytes.
 */
export function stripGeoPackageHeader(blob: Uint8Array): Uint8Array {
  // 'G','P' magic identifies a GeoPackage geometry blob; otherwise assume the
  // value is already standalone WKB (byte-order byte 0x00 or 0x01).
  if (blob.length < 2 || blob[0] !== 0x47 || blob[1] !== 0x50) return blob;
  if (blob.length < 8) {
    throw new Error("Invalid GeoPackage geometry blob: truncated header.");
  }
  const flags = blob[3];
  const envelopeIndicator = (flags >> 1) & 0x07;
  if (envelopeIndicator >= ENVELOPE_BYTES.length) {
    throw new Error(
      `Invalid GeoPackage geometry blob: reserved envelope indicator ${envelopeIndicator}.`,
    );
  }
  const headerLength = 8 + ENVELOPE_BYTES[envelopeIndicator];
  if (blob.length < headerLength) {
    throw new Error("Invalid GeoPackage geometry blob: truncated envelope.");
  }
  return blob.subarray(headerLength);
}

/**
 * Decodes a standalone WKB (Well-Known Binary) buffer into a GeoJSON geometry.
 *
 * Handles mixed byte order, ISO WKB dimensionality (Z/M, where the type code is
 * offset by 1000/2000/3000) and the PostGIS EWKB Z/M/SRID high-bit flags. The M
 * ordinate is dropped; Z is kept so a `[x, y, z]` position survives. Throws on
 * the curved geometry types (CircularString and friends, codes 8-12) that
 * GeoJSON cannot represent.
 *
 * @param bytes - The WKB buffer (no GeoPackage header).
 * @returns The decoded GeoJSON geometry.
 */
export function decodeWkb(bytes: Uint8Array): Geometry {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;

  function readGeometry(): Geometry {
    const little = view.getUint8(offset) === 1;
    offset += 1;
    const rawType = view.getUint32(offset, little);
    offset += 4;

    // PostGIS EWKB encodes Z/M/SRID in the high bits; ISO WKB encodes Z/M by
    // offsetting the type code (1000 = Z, 2000 = M, 3000 = ZM). Support both so
    // any standards-conformant GeoPackage geometry blob decodes.
    const hasEwkbZ = (rawType & 0x80000000) !== 0;
    const hasEwkbM = (rawType & 0x40000000) !== 0;
    const hasSrid = (rawType & 0x20000000) !== 0;
    const baseType = rawType & 0xffff;
    const isoGroup = Math.floor((baseType % 4000) / 1000);
    const code = baseType % 1000;
    const hasZ = hasEwkbZ || isoGroup === 1 || isoGroup === 3;
    const hasM = hasEwkbM || isoGroup === 2 || isoGroup === 3;

    // An EWKB SRID prefix precedes the coordinates; skip it (the layer CRS is
    // taken from the GeoPackage metadata, not the per-geometry SRID).
    if (hasSrid) offset += 4;

    const readPosition = (): Position => {
      const x = view.getFloat64(offset, little);
      offset += 8;
      const y = view.getFloat64(offset, little);
      offset += 8;
      let z: number | undefined;
      if (hasZ) {
        z = view.getFloat64(offset, little);
        offset += 8;
      }
      if (hasM) offset += 8; // M is not represented in GeoJSON.
      return z === undefined ? [x, y] : [x, y, z];
    };

    const readPositions = (): Position[] => {
      const count = view.getUint32(offset, little);
      offset += 4;
      const positions: Position[] = [];
      for (let i = 0; i < count; i += 1) positions.push(readPosition());
      return positions;
    };

    const readRings = (): Position[][] => {
      const count = view.getUint32(offset, little);
      offset += 4;
      const rings: Position[][] = [];
      for (let i = 0; i < count; i += 1) rings.push(readPositions());
      return rings;
    };

    const readChildren = (): Geometry[] => {
      const count = view.getUint32(offset, little);
      offset += 4;
      const children: Geometry[] = [];
      for (let i = 0; i < count; i += 1) children.push(readGeometry());
      return children;
    };

    switch (code) {
      case 1:
        return { type: "Point", coordinates: readPosition() };
      case 2:
        return { type: "LineString", coordinates: readPositions() };
      case 3:
        return { type: "Polygon", coordinates: readRings() };
      case 4: {
        const points = readChildren();
        return {
          type: "MultiPoint",
          coordinates: points.map(
            (p) => (p as { coordinates: Position }).coordinates,
          ),
        };
      }
      case 5: {
        const lines = readChildren();
        return {
          type: "MultiLineString",
          coordinates: lines.map(
            (l) => (l as { coordinates: Position[] }).coordinates,
          ),
        };
      }
      case 6: {
        const polygons = readChildren();
        return {
          type: "MultiPolygon",
          coordinates: polygons.map(
            (p) => (p as { coordinates: Position[][] }).coordinates,
          ),
        };
      }
      case 7:
        return { type: "GeometryCollection", geometries: readChildren() };
      default:
        // Codes 8-12 are the curved geometries (CircularString, CompoundCurve,
        // CurvePolygon, MultiCurve, MultiSurface) that GeoJSON cannot represent.
        throw new Error(
          `Unsupported WKB geometry type ${code}${
            code >= 8 && code <= 12
              ? " (curved geometries are not supported)"
              : ""
          }.`,
        );
    }
  }

  return readGeometry();
}

/**
 * Lists every `features` row in `gpkg_contents` that has a registered geometry
 * column, in declaration order. Mirrors GDAL's layer enumeration so a
 * multi-layer GeoPackage can be expanded one layer per row.
 */
function selectLayers(db: SqlJsDatabase): GeoPackageLayer[] {
  // Both tables are referenced by the JOIN below. gpkg_contents is mandatory in
  // the spec, but guard it too so a malformed file returns no layers here rather
  // than throwing an opaque sql.js error from the JOIN.
  if (!tableExists(db, "gpkg_geometry_columns")) return [];
  if (!tableExists(db, "gpkg_contents")) return [];
  const result = db.exec(
    // COLLATE NOCASE: SQLite's default BINARY collation makes the join
    // case-sensitive, but a producer can spell the same table differently in
    // gpkg_contents and gpkg_geometry_columns (SQLite table names are
    // case-insensitive). gpkgOgrContents.ts handles the same mismatch.
    `SELECT g.table_name, g.column_name, g.srs_id
     FROM gpkg_geometry_columns g
     JOIN gpkg_contents c ON c.table_name = g.table_name COLLATE NOCASE
     WHERE lower(c.data_type) = 'features'
     ORDER BY c.rowid`,
  );
  const rows = result[0]?.values ?? [];
  return rows.map((row) => {
    const table = String(row[0]);
    return {
      table,
      geometryColumn: String(row[1]),
      srsId: row[2] == null ? null : Number(row[2]),
      idColumn: findIdColumn(db, table),
    };
  });
}

/** Finds a table's INTEGER PRIMARY KEY column (excluded from properties). */
function findIdColumn(db: SqlJsDatabase, table: string): string | null {
  let idColumn: string | null = null;
  for (const info of db.exec(`PRAGMA table_info(${quoteIdentifier(table)})`)[0]
    ?.values ?? []) {
    // table_info columns: cid, name, type, notnull, dflt_value, pk.
    if (info[5] === 1) idColumn = String(info[1]);
  }
  return idColumn;
}

/**
 * Picks the layer to read: the named layer when `sourceLayer` is given (matched
 * case-insensitively), otherwise the first feature layer. Returns null when the
 * file has no matching feature layer.
 */
function selectLayer(
  db: SqlJsDatabase,
  sourceLayer?: string,
): GeoPackageLayer | null {
  const layers = selectLayers(db);
  if (layers.length === 0) return null;
  if (!sourceLayer) return layers[0];
  const target = sourceLayer.toLowerCase();
  return layers.find((layer) => layer.table.toLowerCase() === target) ?? null;
}

// EPSG codes whose horizontal axes are already WGS84 lon/lat, so reprojecting
// to 4326 is a no-op: 4326 (2D) and 4979 (3D geographic, same lat/lon).
const WGS84_EPSG_CODES = new Set([4326, 4979]);

/**
 * Resolves the layer's SRS to an EPSG code, or null when it is WGS84 lon/lat or
 * undefined (srs_id 0 = undefined geographic, -1 = undefined cartesian). Only
 * EPSG-organization rows are reprojectable here.
 */
function resolveEpsgCode(
  db: SqlJsDatabase,
  srsId: number | null,
): number | null {
  // srs_id 0 = undefined geographic, -1 = undefined cartesian (GeoPackage spec).
  if (
    srsId == null ||
    srsId === 0 ||
    srsId === -1 ||
    WGS84_EPSG_CODES.has(srsId)
  ) {
    return null;
  }
  if (!tableExists(db, "gpkg_spatial_ref_sys")) return null;
  const row = db.exec(
    `SELECT organization, organization_coordsys_id
     FROM gpkg_spatial_ref_sys WHERE srs_id = :id`,
    { ":id": srsId },
  )[0]?.values[0];
  if (!row) return null;
  const organization = String(row[0] ?? "").toUpperCase();
  const code = row[1] == null ? null : Number(row[1]);
  // A non-numeric organization_coordsys_id yields NaN, which is not null; guard
  // it so a malformed row is treated as "no reprojection" instead of tagging the
  // collection "EPSG:NaN" (which silently fails to reproject and misrenders).
  if (organization !== "EPSG" || code == null || !Number.isFinite(code)) {
    return null;
  }
  return WGS84_EPSG_CODES.has(code) ? null : code;
}

/** Reads every feature of `layer` from an open database into a FeatureCollection. */
function readLayerFeatures(
  db: SqlJsDatabase,
  layer: GeoPackageLayer,
): FeatureCollection<Geometry | null> {
  const result = db.exec(`SELECT * FROM ${quoteIdentifier(layer.table)}`);
  const features: Feature<Geometry | null>[] = [];
  if (result.length > 0) {
    const columns = result[0].columns;
    const geometryIndex = columns.indexOf(layer.geometryColumn);
    // The geometry column is declared in gpkg_geometry_columns; if SELECT * does
    // not return it, the file is inconsistent. Fail loudly rather than emit every
    // feature with a silent null geometry.
    if (geometryIndex < 0) {
      throw new Error(
        `GeoPackage layer "${layer.table}" is missing its declared geometry ` +
          `column "${layer.geometryColumn}".`,
      );
    }
    const idIndex = layer.idColumn ? columns.indexOf(layer.idColumn) : -1;

    for (const row of result[0].values) {
      const properties: Record<string, unknown> = {};
      for (let i = 0; i < columns.length; i += 1) {
        if (i === geometryIndex || i === idIndex) continue;
        const value = row[i];
        // sql.js returns BLOB columns as Uint8Array; binary attributes are not
        // JSON-serialisable, so drop them (matching the ST_Read path).
        if (value instanceof Uint8Array) continue;
        properties[columns[i]] = value;
      }

      const rawGeometry = row[geometryIndex];
      let geometry: Geometry | null = null;
      if (rawGeometry instanceof Uint8Array && rawGeometry.length > 0) {
        try {
          const wkb = stripGeoPackageHeader(rawGeometry);
          // A GeoPackage "empty geometry" header carries no WKB body.
          geometry = wkb.length > 0 ? decodeWkb(wkb) : null;
        } catch (error) {
          // One unreadable geometry (malformed header, truncated WKB, or an
          // unsupported curved type) must not abort the whole layer. Keep the
          // feature with a null geometry and warn so the loss is diagnosable
          // rather than silent.
          console.warn(
            `[maplibre-gl-vector] Skipped an unreadable geometry in GeoPackage layer "${layer.table}":`,
            error,
          );
        }
      }
      features.push({ type: "Feature", geometry, properties });
    }
  }
  return { type: "FeatureCollection", features };
}

/**
 * A SQLite/GeoPackage file begins with the "SQLite format 3\0" magic.
 *
 * Only the SQLite magic is inspected, so a non-GeoPackage SQLite database with a
 * `.gpkg` name also passes; such a file then yields no feature layers in
 * {@link readGeoPackageSync} and surfaces an explicit error rather than falling
 * through to `ST_Read` (which cannot read it either).
 */
export function isLikelyGeoPackage(bytes: Uint8Array): boolean {
  return looksLikeSqlite(bytes);
}

/**
 * Lists the feature-table names of a GeoPackage. Used to expand a multi-layer
 * container into one vector layer per table without touching GDAL.
 *
 * @param SQL - An initialised sql.js factory.
 * @param bytes - The GeoPackage file bytes.
 * @returns The feature-table names, in declaration order.
 */
export function listGeoPackageLayersSync(
  SQL: SqlJsStatic,
  bytes: Uint8Array,
): string[] {
  const db = new SQL.Database(bytes);
  try {
    return selectLayers(db).map((layer) => layer.table);
  } finally {
    db.close();
  }
}

/**
 * Synchronous core of {@link readGeoPackage}: read every feature of the selected
 * (or first) feature layer into a GeoJSON FeatureCollection. Separated so it can
 * be unit-tested with an already-initialised sql.js factory.
 *
 * @param SQL - An initialised sql.js factory.
 * @param bytes - The GeoPackage file bytes.
 * @param sourceLayer - The feature table to read; the first layer when omitted.
 * @returns The collection plus the source EPSG code (null when already WGS84).
 */
export function readGeoPackageSync(
  SQL: SqlJsStatic,
  bytes: Uint8Array,
  sourceLayer?: string,
): GeoPackageReadResult {
  const db = new SQL.Database(bytes);
  try {
    const layer = selectLayer(db, sourceLayer);
    if (!layer) {
      throw new Error(
        sourceLayer
          ? `GeoPackage has no feature layer named "${sourceLayer}".`
          : "No vector feature layer found in this GeoPackage.",
      );
    }
    return {
      featureCollection: readLayerFeatures(db, layer),
      epsgCode: resolveEpsgCode(db, layer.srsId),
    };
  } finally {
    db.close();
  }
}

/**
 * Lists the feature-table names of a GeoPackage buffer, loading sql.js on
 * demand.
 *
 * @param bytes - The GeoPackage file bytes.
 * @param baseUrl - Optional sql.js base URL; see {@link loadSqlJs}.
 * @returns The feature-table names, in declaration order.
 */
export async function listGeoPackageLayers(
  bytes: Uint8Array,
  baseUrl?: string,
): Promise<string[]> {
  const SQL = await loadSqlJs(baseUrl);
  return listGeoPackageLayersSync(SQL, bytes);
}

/**
 * Reads a GeoPackage buffer into a GeoJSON FeatureCollection via sql.js,
 * bypassing GDAL. Returns the collection plus the source EPSG code (null when
 * already WGS84) so the caller can reproject. Loads sql.js on demand.
 *
 * @param bytes - The GeoPackage file bytes.
 * @param sourceLayer - The feature table to read; the first layer when omitted.
 * @param baseUrl - Optional sql.js base URL; see {@link loadSqlJs}.
 * @returns The collection and source EPSG code.
 */
export async function readGeoPackage(
  bytes: Uint8Array,
  sourceLayer?: string,
  baseUrl?: string,
): Promise<GeoPackageReadResult> {
  const SQL = await loadSqlJs(baseUrl);
  return readGeoPackageSync(SQL, bytes, sourceLayer);
}
