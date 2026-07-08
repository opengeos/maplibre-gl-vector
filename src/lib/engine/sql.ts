import type { VectorFormat } from '../core/types';

/**
 * Maximum number of features encoded into a single tile.
 */
export const TILE_FEATURE_LIMIT = 50_000;

/**
 * Quotes a SQL identifier.
 *
 * @param name - Identifier to quote
 * @returns The double-quoted identifier
 */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Quotes a SQL string literal.
 *
 * @param value - String value to quote
 * @returns The single-quoted literal
 */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Builds the reader expression for a registered file or URL.
 *
 * GeoParquet and CSV use DuckDB's native readers; everything else goes
 * through the spatial extension's ST_Read (GDAL).
 *
 * @param format - The source format
 * @param path - Registered file name or URL
 * @param sourceLayer - Optional layer inside multi-layer containers
 * @returns The FROM-clause reader expression
 */
export function readerFor(format: VectorFormat, path: string, sourceLayer?: string): string {
  switch (format) {
    case 'geoparquet':
      return `read_parquet(${quoteLiteral(path)})`;
    case 'csv':
      return `read_csv(${quoteLiteral(path)})`;
    default: {
      const layerArg = sourceLayer ? `, layer = ${quoteLiteral(sourceLayer)}` : '';
      return `ST_Read(${quoteLiteral(path)}${layerArg})`;
    }
  }
}

/**
 * Builds the GDAL virtual path for a source, wrapping zip archives in
 * /vsizip/ so zipped shapefiles can be read directly.
 *
 * @param format - The source format
 * @param path - Registered file name or URL
 * @returns The path to hand to ST_Read
 */
export function gdalPath(format: VectorFormat, path: string): string {
  if (format === 'shapefile' && /\.zip$/i.test(path.split(/[?#]/)[0])) {
    const prefix = /^https?:\/\//i.test(path) ? '/vsizip//vsicurl/' : '/vsizip/';
    return `${prefix}${path}`;
  }
  return path;
}

/**
 * SQL describing the columns a relation produces (name and type),
 * without materializing it.
 *
 * @param relation - A quoted table name or reader expression
 * @returns The query text
 */
export function columnsQueryFromDescribe(relation: string): string {
  return `DESCRIBE SELECT * FROM ${relation}`;
}

export type GeometryEncoding = 'geometry' | 'wkb' | 'base64-wkb';

export interface ReaderColumnInfo {
  name: string;
  type: string;
}

export interface DetectedGeometryColumn {
  name: string;
  encoding: GeometryEncoding;
  requiresBase64WkbValidation?: boolean;
  base64WkbCandidates?: string[];
}

const WKB_GEOMETRY_COLUMN_NAMES = [
  'geometry',
  'geom',
  'wkb_geometry',
  'geometry_wkb',
  'geom_wkb',
  'wkb',
];

function wkbNameRank(name: string): number {
  const rank = WKB_GEOMETRY_COLUMN_NAMES.indexOf(name.toLowerCase());
  return rank === -1 ? Number.MAX_SAFE_INTEGER : rank;
}

/**
 * Finds the geometry column produced by a reader. Native DuckDB GEOMETRY
 * columns win; plain Parquet fallbacks may carry WKB as bytes or as a
 * base64-encoded string in a well-known geometry column. String candidates
 * must be value-probed before SQL generation because geometry-like names are
 * sometimes ordinary attributes.
 *
 * @param columns - Column names and types from DESCRIBE
 * @returns Detected geometry column, if one is recognizable
 */
export function detectGeometryColumn(
  columns: ReaderColumnInfo[],
): DetectedGeometryColumn | undefined {
  const native = columns.find((column) => column.type.toUpperCase().startsWith('GEOMETRY'));
  if (native) return { name: native.name, encoding: 'geometry' };

  const sortedWkbCandidates = columns
    .filter((column) => wkbNameRank(column.name) !== Number.MAX_SAFE_INTEGER)
    .sort((a, b) => wkbNameRank(a.name) - wkbNameRank(b.name));
  const binaryWkb = sortedWkbCandidates.find((column) =>
    /^(BLOB|BINARY|VARBINARY)/i.test(column.type),
  );
  if (binaryWkb) return { name: binaryWkb.name, encoding: 'wkb' };

  const base64WkbCandidates = sortedWkbCandidates
    .filter((column) => /^(VARCHAR|TEXT|STRING)/i.test(column.type))
    .map((column) => column.name);
  if (base64WkbCandidates.length > 0) {
    return {
      name: base64WkbCandidates[0],
      encoding: 'base64-wkb',
      requiresBase64WkbValidation: true,
      base64WkbCandidates,
    };
  }
  return undefined;
}

/**
 * SQL creating the ingest table from a reader, normalizing the geometry
 * column to `geom`.
 *
 * @param tableName - The table to create
 * @param reader - Reader expression from {@link readerFor}
 * @param geometryColumn - Name of the source geometry column
 * @returns The statement text
 */
export function createTableSql(
  tableName: string,
  reader: string,
  geometryColumn: string,
): string {
  const rename =
    geometryColumn === 'geom'
      ? ''
      : ` RENAME (${quoteIdent(geometryColumn)} AS geom)`;
  return `CREATE OR REPLACE TABLE ${quoteIdent(tableName)} AS SELECT *${rename} FROM ${reader}`;
}

function wkbGeometryExpression(geometry: DetectedGeometryColumn): string {
  if (geometry.requiresBase64WkbValidation) {
    throw new Error('Base64 WKB geometry candidates must be validated before SQL generation.');
  }
  const column = quoteIdent(geometry.name);
  const wkb = geometry.encoding === 'base64-wkb' ? `from_base64(${column})` : column;
  return `ST_GeomFromWKB(${wkb})`;
}

function createRelationFromGeometrySql(
  relationKind: 'TABLE' | 'VIEW',
  tableName: string,
  reader: string,
  geometry: DetectedGeometryColumn,
): string {
  if (geometry.encoding === 'geometry') {
    return relationKind === 'TABLE'
      ? createTableSql(tableName, reader, geometry.name)
      : createViewSql(tableName, reader, geometry.name);
  }
  const geometryColumn = quoteIdent(geometry.name);
  return (
    `CREATE OR REPLACE ${relationKind} ${quoteIdent(tableName)} AS ` +
    `SELECT * EXCLUDE (${geometryColumn}), ${wkbGeometryExpression(geometry)} AS geom ` +
    `FROM ${reader}`
  );
}

/**
 * SQL creating the ingest table from a reader with a detected geometry column.
 *
 * @param tableName - The table to create
 * @param reader - Reader expression from {@link readerFor}
 * @param geometry - Detected geometry column and encoding
 * @returns The statement text
 */
export function createTableFromGeometrySql(
  tableName: string,
  reader: string,
  geometry: DetectedGeometryColumn,
): string {
  return createRelationFromGeometrySql('TABLE', tableName, reader, geometry);
}

/**
 * SQL creating the ingest table from a CSV with a WKT geometry column.
 *
 * @param tableName - The table to create
 * @param reader - Reader expression
 * @param wktColumn - Name of the WKT column
 * @returns The statement text
 */
export function createTableFromWktSql(
  tableName: string,
  reader: string,
  wktColumn: string,
): string {
  return (
    `CREATE OR REPLACE TABLE ${quoteIdent(tableName)} AS ` +
    `SELECT * EXCLUDE (${quoteIdent(wktColumn)}), ` +
    `ST_GeomFromText(${quoteIdent(wktColumn)}) AS geom FROM ${reader}`
  );
}

/**
 * SQL creating the ingest table from a CSV with longitude/latitude
 * columns.
 *
 * @param tableName - The table to create
 * @param reader - Reader expression
 * @param lonColumn - Longitude column name
 * @param latColumn - Latitude column name
 * @returns The statement text
 */
export function createTableFromLonLatSql(
  tableName: string,
  reader: string,
  lonColumn: string,
  latColumn: string,
): string {
  return (
    `CREATE OR REPLACE TABLE ${quoteIdent(tableName)} AS ` +
    `SELECT *, ST_Point(${quoteIdent(lonColumn)}, ${quoteIdent(latColumn)}) AS geom ` +
    `FROM ${reader}`
  );
}

/**
 * SQL creating a streaming view over a reader instead of materializing
 * a table, normalizing the geometry column to `geom`. Used for
 * GeoParquet streaming ingest: queries hit the file in place (with
 * HTTP range reads for remote files).
 *
 * @param tableName - The view to create
 * @param reader - Reader expression from {@link readerFor}
 * @param geometryColumn - Name of the source geometry column
 * @returns The statement text
 */
export function createViewSql(
  tableName: string,
  reader: string,
  geometryColumn: string,
): string {
  const rename =
    geometryColumn === 'geom' ? '' : ` RENAME (${quoteIdent(geometryColumn)} AS geom)`;
  return `CREATE OR REPLACE VIEW ${quoteIdent(tableName)} AS SELECT *${rename} FROM ${reader}`;
}

/**
 * SQL creating a streaming view from a reader with a detected geometry column.
 *
 * @param tableName - The view to create
 * @param reader - Reader expression from {@link readerFor}
 * @param geometry - Detected geometry column and encoding
 * @returns The statement text
 */
export function createViewFromGeometrySql(
  tableName: string,
  reader: string,
  geometry: DetectedGeometryColumn,
): string {
  return createRelationFromGeometrySql('VIEW', tableName, reader, geometry);
}

/**
 * Recognizes a GeoParquet bbox covering column: a STRUCT with
 * xmin/ymin/xmax/ymax fields named `bbox` or ending in `_bbox`
 * (e.g. `geometry_bbox`, `geom_bbox`).
 *
 * @param name - Column name
 * @param type - Column type string from DESCRIBE
 * @returns True when the column is a bbox covering column
 */
export function isBboxCoveringColumn(name: string, type: string): boolean {
  const lower = name.toLowerCase();
  if (lower !== 'bbox' && !lower.endsWith('_bbox')) return false;
  const upper = type.toUpperCase();
  return (
    upper.startsWith('STRUCT') &&
    /\bXMIN\b/.test(upper) &&
    /\bYMIN\b/.test(upper) &&
    /\bXMAX\b/.test(upper) &&
    /\bYMAX\b/.test(upper)
  );
}

/**
 * SQL computing feature count and extent from a bbox covering column,
 * avoiding a full geometry scan on streamed sources.
 *
 * @param tableName - The table or view to summarize
 * @param bboxColumn - The bbox covering column name
 * @returns The query text
 */
export function bboxSummaryQuery(tableName: string, bboxColumn: string): string {
  const table = quoteIdent(tableName);
  const bbox = quoteIdent(bboxColumn);
  return (
    `SELECT count(*)::DOUBLE AS feature_count, ` +
    `min(${bbox}.xmin)::DOUBLE AS xmin, min(${bbox}.ymin)::DOUBLE AS ymin, ` +
    `max(${bbox}.xmax)::DOUBLE AS xmax, max(${bbox}.ymax)::DOUBLE AS ymax ` +
    `FROM ${table}`
  );
}

/**
 * SQL sampling the distinct geometry types of a table or view without
 * scanning every row (streamed sources can be large).
 *
 * @param tableName - The table or view to inspect
 * @param sampleSize - Number of rows to sample
 * @returns The query text
 */
export function sampledGeometryTypesQuery(tableName: string, sampleSize = 100): string {
  return (
    `SELECT DISTINCT CAST(ST_GeometryType(geom) AS VARCHAR) AS geometry_type ` +
    `FROM (SELECT geom FROM ${quoteIdent(tableName)} WHERE geom IS NOT NULL LIMIT ${sampleSize})`
  );
}

/**
 * SQL generating an MVT tile from a streamed (EPSG:4326) source.
 *
 * The geometry is transformed per tile; when a bbox covering column is
 * present its predicate is pushed into parquet row-group statistics so
 * only intersecting row groups are read.
 *
 * @param tableName - The streaming view
 * @param layerName - MVT layer name (matches the map source-layer)
 * @param z - Tile zoom
 * @param x - Tile column
 * @param y - Tile row
 * @param bbox4326 - Tile bounds in EPSG:4326 [west, south, east, north]
 * @param propertyColumns - Non-geometry columns to encode as properties
 * @param bboxColumn - Optional bbox covering column for pushdown
 * @returns The query text
 */
export function mvtTileStreamQuery(
  tableName: string,
  layerName: string,
  z: number,
  x: number,
  y: number,
  bbox4326: [number, number, number, number],
  propertyColumns: string[],
  bboxColumn?: string,
): string {
  const table = quoteIdent(tableName);
  const [west, south, east, north] = bbox4326;
  const env3857 = `ST_TileEnvelope(${z}, ${x}, ${y})`;
  const env4326 = `ST_MakeEnvelope(${west}, ${south}, ${east}, ${north})`;
  const props = propertyColumns
    .map((c) => `${quoteLiteral(c)}: TRY_CAST(${quoteIdent(c)} AS VARCHAR)`)
    .join(', ');
  const geometry =
    `ST_AsMVTGeom(ST_Transform(geom, 'EPSG:4326', 'EPSG:3857', always_xy := true), ` +
    `ST_Extent(${env3857}))`;
  const struct = `{'geometry': ${geometry}${props ? `, ${props}` : ''}}`;
  const bboxFilter = bboxColumn
    ? `${quoteIdent(bboxColumn)}.xmin <= ${east} AND ${quoteIdent(bboxColumn)}.xmax >= ${west} ` +
      `AND ${quoteIdent(bboxColumn)}.ymin <= ${north} AND ${quoteIdent(bboxColumn)}.ymax >= ${south} AND `
    : '';
  return (
    `SELECT ST_AsMVT(${struct}, ${quoteLiteral(layerName)}) AS tile FROM (` +
    `SELECT * FROM ${table} ` +
    `WHERE ${bboxFilter}geom IS NOT NULL AND ST_Intersects(geom, ${env4326}) ` +
    `LIMIT ${TILE_FEATURE_LIMIT})`
  );
}

/**
 * SQL computing feature count and extent of a table.
 *
 * @param tableName - The table to summarize
 * @returns The query text
 */
export function summaryQuery(tableName: string): string {
  const table = quoteIdent(tableName);
  return (
    `SELECT count(*)::DOUBLE AS feature_count, ` +
    `ST_XMin(ST_Extent_Agg(geom)) AS xmin, ST_YMin(ST_Extent_Agg(geom)) AS ymin, ` +
    `ST_XMax(ST_Extent_Agg(geom)) AS xmax, ST_YMax(ST_Extent_Agg(geom)) AS ymax ` +
    `FROM ${table} WHERE geom IS NOT NULL`
  );
}

/**
 * SQL listing the distinct geometry types in a table.
 *
 * @param tableName - The table to inspect
 * @returns The query text
 */
export function geometryTypesQuery(tableName: string): string {
  return (
    `SELECT DISTINCT CAST(ST_GeometryType(geom) AS VARCHAR) AS geometry_type ` +
    `FROM ${quoteIdent(tableName)} WHERE geom IS NOT NULL LIMIT 10`
  );
}

/**
 * SQL exporting a table as GeoJSON geometry strings plus properties.
 *
 * @param tableName - The table to export
 * @param propertyColumns - Non-geometry columns to include
 * @returns The query text
 */
export function exportGeoJSONQuery(tableName: string, propertyColumns: string[]): string {
  const props = propertyColumns.map((c) => quoteIdent(c)).join(', ');
  const selectProps = props ? `, ${props}` : '';
  return (
    `SELECT ST_AsGeoJSON(geom) AS __geojson${selectProps} ` +
    `FROM ${quoteIdent(tableName)} WHERE geom IS NOT NULL`
  );
}

/**
 * SQL statements preparing a table for tile generation: a Web Mercator
 * geometry column and an R-Tree index.
 *
 * @param tableName - The table to prepare
 * @returns Statements to run in order; the index statement may fail on
 *   builds without R-Tree support and should be guarded
 */
export function prepareTilesSql(tableName: string): { transform: string[]; index: string } {
  const table = quoteIdent(tableName);
  const indexName = quoteIdent(`idx_${tableName}_3857`);
  return {
    transform: [
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS geom_3857 GEOMETRY`,
      `UPDATE ${table} SET geom_3857 = ST_Transform(geom, 'EPSG:4326', 'EPSG:3857', always_xy := true)`,
    ],
    index: `CREATE INDEX IF NOT EXISTS ${indexName} ON ${table} USING RTREE (geom_3857)`,
  };
}

/**
 * SQL generating an MVT tile for a z/x/y request using ST_AsMVT.
 *
 * Properties are cast to VARCHAR for MVT encoding robustness.
 *
 * @param tableName - The prepared source table
 * @param layerName - MVT layer name (matches the map source-layer)
 * @param z - Tile zoom
 * @param x - Tile column
 * @param y - Tile row
 * @param propertyColumns - Non-geometry columns to encode as properties
 * @returns The query text
 */
export function mvtTileQuery(
  tableName: string,
  layerName: string,
  z: number,
  x: number,
  y: number,
  propertyColumns: string[],
): string {
  const table = quoteIdent(tableName);
  const env = `ST_TileEnvelope(${z}, ${x}, ${y})`;
  const props = propertyColumns
    .map((c) => `${quoteLiteral(c)}: TRY_CAST(${quoteIdent(c)} AS VARCHAR)`)
    .join(', ');
  const struct = `{'geometry': ST_AsMVTGeom(geom_3857, ST_Extent(${env}))${props ? `, ${props}` : ''}}`;
  return (
    `SELECT ST_AsMVT(${struct}, ${quoteLiteral(layerName)}) AS tile FROM (` +
    `SELECT * FROM ${table} ` +
    `WHERE geom_3857 IS NOT NULL AND ST_Intersects(geom_3857, ${env}) ` +
    `LIMIT ${TILE_FEATURE_LIMIT})`
  );
}

/**
 * SQL selecting tile-intersecting features as GeoJSON for the JS MVT
 * fallback encoder (used when ST_AsMVT is unavailable).
 *
 * @param tableName - The source table
 * @param bbox - Tile bounds in EPSG:4326 [west, south, east, north]
 * @param propertyColumns - Non-geometry columns to include
 * @returns The query text
 */
export function tileFeaturesQuery(
  tableName: string,
  bbox: [number, number, number, number],
  propertyColumns: string[],
): string {
  const table = quoteIdent(tableName);
  const envelope = `ST_MakeEnvelope(${bbox[0]}, ${bbox[1]}, ${bbox[2]}, ${bbox[3]})`;
  const props = propertyColumns.map((c) => quoteIdent(c)).join(', ');
  const selectProps = props ? `, ${props}` : '';
  return (
    `SELECT ST_AsGeoJSON(geom) AS __geojson${selectProps} FROM ${table} ` +
    `WHERE geom IS NOT NULL AND ST_Intersects(geom, ${envelope}) ` +
    `LIMIT ${TILE_FEATURE_LIMIT}`
  );
}

/**
 * SQL listing the named layers inside a multi-layer container
 * (GeoPackage tables, KML folders, ...) via ST_Read_Meta.
 *
 * @param path - Registered file name or URL
 * @returns The query text
 */
export function layersMetaQuery(path: string): string {
  return (
    `SELECT layer.name AS name FROM ` +
    `(SELECT unnest(layers) AS layer FROM ST_Read_Meta(${quoteLiteral(path)}))`
  );
}

/**
 * An `ST_Read` reader that keeps geometry as raw WKB (a `wkb_geometry` BLOB)
 * instead of decoding it into DuckDB's GEOMETRY type. Used as a fallback for
 * surface geometries (TIN / PolyhedralSurface) whose WKB DuckDB Spatial cannot
 * parse, so the raw bytes can be decoded in JS instead.
 *
 * @param path - Registered file name or URL
 * @param sourceLayer - Optional OGR layer name for a multi-layer source
 * @returns The reader expression
 */
export function keepWkbReaderFor(path: string, sourceLayer?: string): string {
  const layerArg = sourceLayer ? `, layer = ${quoteLiteral(sourceLayer)}` : '';
  return `ST_Read(${quoteLiteral(path)}${layerArg}, keep_wkb = true)`;
}

/**
 * SQL reading the first layer's first geometry field CRS from `ST_Read_Meta`,
 * used to reproject a surface-geometry fallback layer to WGS84. `wkt` is the
 * fallback when GDAL could not resolve an EPSG code (e.g. a custom ESRI `.prj`);
 * `ST_Transform` accepts a WKT string source just as it does `AUTHORITY:CODE`.
 *
 * @param path - Registered file name or URL
 * @returns The query text
 */
export function sourceCrsMetaQuery(path: string): string {
  return (
    `SELECT ` +
    `layers[1].geometry_fields[1].crs.auth_name AS auth_name, ` +
    `layers[1].geometry_fields[1].crs.auth_code AS auth_code, ` +
    `layers[1].geometry_fields[1].crs.wkt AS wkt ` +
    `FROM ST_Read_Meta(${quoteLiteral(path)})`
  );
}

/**
 * SQL probing whether the loaded spatial build supports ST_AsMVT.
 *
 * @returns The probe query text
 */
export function mvtProbeQuery(): string {
  return (
    `SELECT ST_AsMVT({'geometry': ST_AsMVTGeom(ST_Point(0, 0), ` +
    `ST_Extent(ST_TileEnvelope(0, 0, 0)))}, 'probe') AS tile`
  );
}

/**
 * Column names recognized as WKT geometry in CSV files.
 */
export const WKT_COLUMN_NAMES = ['geometry', 'wkt', 'geom', 'the_geom', 'wkb_geometry'];

/**
 * Column name pairs recognized as longitude/latitude in CSV files.
 */
export const LON_LAT_COLUMN_PAIRS: Array<[string, string]> = [
  ['longitude', 'latitude'],
  ['lon', 'lat'],
  ['lng', 'lat'],
  ['x', 'y'],
];
