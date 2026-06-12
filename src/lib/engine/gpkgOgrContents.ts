/**
 * Repairs GeoPackages that lack the `gpkg_ogr_contents` feature-count table so
 * DuckDB-WASM's `ST_Read` can open them without crashing.
 *
 * When a GeoPackage has no `gpkg_ogr_contents`, GDAL's GeoPackage driver cannot
 * get a cheap feature count and takes its multithreaded async Arrow read path,
 * which calls `std::thread`/`pthread_create`. The single-threaded DuckDB-WASM
 * build loaded in a browser (no cross-origin isolation, so no pthread support)
 * then fails the read with:
 *
 *   "thread constructor failed: Resource temporarily unavailable"
 *
 * Files written by ogr2ogr/GDAL include `gpkg_ogr_contents` and load fine; files
 * written by QGIS often omit it and crash. Injecting the table with a cached
 * count keeps GDAL on the fast, single-threaded path. See
 * https://github.com/opengeos/GeoLibre/issues/258.
 *
 * sql.js is loaded from a CDN on demand (only when a GeoPackage is added),
 * mirroring how duckdb-wasm is loaded, so it is not a bundled dependency.
 */

import { loadScriptFromCdn } from './duckdbLoader';

/** Pinned sql.js version loaded from the CDN. */
export const SQLJS_VERSION = '1.13.0';

/** jsDelivr base URL for the pinned sql.js package. */
export const SQLJS_CDN_BASE = `https://cdn.jsdelivr.net/npm/sql.js@${SQLJS_VERSION}`;

const SQLITE_MAGIC = 'SQLite format 3\0';

/** Minimal structural types for the sql.js API surface we use. */
interface SqlJsQueryResult {
  columns: string[];
  values: Array<Array<string | number | Uint8Array | null>>;
}

interface SqlJsDatabase {
  run(sql: string, params?: Record<string, unknown>): void;
  exec(sql: string, params?: Record<string, unknown>): SqlJsQueryResult[];
  export(): Uint8Array;
  close(): void;
}

interface SqlJsStatic {
  Database: new (data?: Uint8Array) => SqlJsDatabase;
}

type InitSqlJs = (config?: {
  locateFile?: (file: string) => string;
}) => Promise<SqlJsStatic>;

/** A SQLite/GeoPackage file begins with the 16-byte "SQLite format 3\0" magic. */
export function looksLikeSqlite(bytes: Uint8Array): boolean {
  if (bytes.length < SQLITE_MAGIC.length) return false;
  for (let i = 0; i < SQLITE_MAGIC.length; i += 1) {
    if (bytes[i] !== SQLITE_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function tableExists(db: SqlJsDatabase, name: string): boolean {
  const result = db.exec(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=:name",
    { ':name': name },
  );
  return result.length > 0 && result[0].values.length > 0;
}

/**
 * Synchronous core of {@link ensureGpkgFeatureCount}, separated so it can be
 * unit-tested with an already-initialised sql.js factory. Returns the original
 * buffer unchanged when the file is not a GeoPackage or already has a count for
 * every feature table; otherwise returns a patched buffer.
 *
 * @param SQL - An initialised sql.js factory.
 * @param bytes - The GeoPackage file bytes.
 * @returns The original or patched bytes.
 */
export function ensureGpkgFeatureCountSync(
  SQL: SqlJsStatic,
  bytes: Uint8Array,
): Uint8Array {
  const db = new SQL.Database(bytes);
  try {
    // gpkg_contents is mandatory in the spec; only touch real GeoPackages.
    if (!tableExists(db, 'gpkg_contents')) return bytes;

    const featureTablesResult = db.exec(
      "SELECT table_name FROM gpkg_contents WHERE data_type='features'",
    );
    if (
      featureTablesResult.length === 0 ||
      featureTablesResult[0].values.length === 0
    ) {
      return bytes;
    }
    const featureTables = featureTablesResult[0].values
      .map((row) => row[0])
      .filter((name): name is string => typeof name === 'string');

    const hasOgrContents = tableExists(db, 'gpkg_ogr_contents');
    const existingCounts = new Set<string>();
    if (hasOgrContents) {
      const existing = db.exec('SELECT table_name FROM gpkg_ogr_contents');
      for (const row of existing[0]?.values ?? []) {
        if (typeof row[0] === 'string') existingCounts.add(row[0]);
      }
    }

    const missing = featureTables.filter((name) => !existingCounts.has(name));
    if (missing.length === 0) return bytes;

    if (!hasOgrContents) {
      db.run(
        'CREATE TABLE gpkg_ogr_contents (' +
          'table_name TEXT NOT NULL PRIMARY KEY, ' +
          'feature_count INTEGER DEFAULT NULL)',
      );
    }

    for (const tableName of missing) {
      const countResult = db.exec(
        `SELECT count(*) FROM ${quoteIdentifier(tableName)}`,
      );
      const count = countResult[0]?.values[0]?.[0] ?? 0;
      db.run(
        'INSERT INTO gpkg_ogr_contents (table_name, feature_count) VALUES (:name, :count)',
        { ':name': tableName, ':count': count },
      );
    }

    return db.export();
  } finally {
    db.close();
  }
}

let sqlJsPromise: Promise<SqlJsStatic> | null = null;

/**
 * Loads sql.js from the CDN (or a self-hosted mirror) and initialises it.
 *
 * @param baseUrl - Optional base URL mirroring jsDelivr's layout for the pinned
 *   {@link SQLJS_VERSION} (a `/dist/sql-wasm.js` UMD script plus the matching
 *   `/dist/sql-wasm.wasm`). Defaults to jsDelivr when unset.
 */
async function loadSqlJs(baseUrl?: string): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    const base = (baseUrl ?? SQLJS_CDN_BASE).replace(/\/+$/, '');
    sqlJsPromise = (async () => {
      await loadScriptFromCdn(`${base}/dist/sql-wasm.js`);
      const initSqlJs = (globalThis as { initSqlJs?: InitSqlJs }).initSqlJs;
      if (!initSqlJs) {
        throw new Error('sql.js failed to expose a global initSqlJs');
      }
      return initSqlJs({ locateFile: (file) => `${base}/dist/${file}` });
    })();
    sqlJsPromise.catch(() => {
      // Allow a retry on the next call when the CDN was unreachable.
      sqlJsPromise = null;
    });
  }
  return sqlJsPromise;
}

/**
 * Returns a GeoPackage buffer guaranteed to carry `gpkg_ogr_contents` for every
 * feature table, patching it in-memory when needed. Non-GeoPackage input and
 * already-complete files are returned untouched. Best-effort: if sql.js fails to
 * load or the file cannot be parsed, the original buffer is returned so the
 * normal `ST_Read` error path still applies.
 *
 * @param bytes - The GeoPackage file bytes.
 * @param baseUrl - Optional sql.js base URL; see {@link loadSqlJs}.
 * @returns The original or patched bytes.
 */
export async function ensureGpkgFeatureCount(
  bytes: Uint8Array,
  baseUrl?: string,
): Promise<Uint8Array> {
  if (!looksLikeSqlite(bytes)) return bytes;
  try {
    const SQL = await loadSqlJs(baseUrl);
    return ensureGpkgFeatureCountSync(SQL, bytes);
  } catch (error) {
    console.warn(
      '[maplibre-gl-vector] Could not ensure gpkg_ogr_contents; reading file as-is.',
      error,
    );
    return bytes;
  }
}
