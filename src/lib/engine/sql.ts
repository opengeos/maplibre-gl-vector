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
