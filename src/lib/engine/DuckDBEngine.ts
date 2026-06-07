import type { Feature, FeatureCollection, Geometry } from 'geojson';
import type { GeometryCategory } from '../core/types';
import type { IEngine, IngestOptions, IngestSummary } from './types';
import type { Bbox } from '../utils/geometry';
import { mergeGeometryCategory } from '../utils/geometry';
import { loadDuckDB, type LoadedDuckDB } from './duckdbLoader';
import { encodeTileFromFeatures, tileBbox4326 } from '../tiles/mvtFallback';
import {
  LON_LAT_COLUMN_PAIRS,
  WKT_COLUMN_NAMES,
  columnsQueryFromDescribe,
  createTableFromLonLatSql,
  createTableFromWktSql,
  createTableSql,
  exportGeoJSONQuery,
  gdalPath,
  geometryTypesQuery,
  layersMetaQuery,
  mvtTileQuery,
  prepareTilesSql,
  quoteIdent,
  readerFor,
  summaryQuery,
  tileFeaturesQuery,
} from './sql';

/**
 * Options for creating the DuckDB engine.
 */
export interface CreateEngineOptions {
  /** Progress message callback (e.g. for the panel status line) */
  onProgress?: (message: string) => void;
}

/**
 * Serializes async work onto a single promise chain. DuckDB-WASM runs
 * queries on one connection, so all engine work (ingest, exports, and
 * every tile) is queued to avoid interleaving.
 */
class QueryQueue {
  private _tail: Promise<unknown> = Promise.resolve();

  /**
   * Appends a task to the queue.
   *
   * @param task - The async task to run
   * @param signal - Optional abort signal checked when the task is
   *   dequeued, so stale tile requests are skipped cheaply
   * @returns The task result
   */
  enqueue<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const run = this._tail.then(() => {
      if (signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      return task();
    });
    this._tail = run.catch(() => undefined);
    return run;
  }
}

interface TableMeta {
  /** Non-geometry columns exported as feature properties */
  propertyColumns: string[];
  /** Whether geom_3857 and the spatial index exist */
  prepared: boolean;
  /** Object URL to revoke with the table */
  objectUrl?: string;
}

interface ColumnInfo {
  name: string;
  type: string;
}

/**
 * Converts an arrow cell value to a JSON-safe property value.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sanitizeValue(value: any): unknown {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case 'bigint':
      return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
    case 'number':
    case 'string':
    case 'boolean':
      return value;
    case 'object':
      if (value instanceof Date) return value.toISOString();
      if (value instanceof Uint8Array) return null;
      try {
        return JSON.parse(
          JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? Number(v) : v)),
        );
      } catch {
        return String(value);
      }
    default:
      return String(value);
  }
}

/**
 * Maps a DuckDB ST_GeometryType value to a broad category.
 */
function categoryFromTypeName(name: string): GeometryCategory {
  const upper = name.toUpperCase();
  if (upper.includes('POINT')) return 'point';
  if (upper.includes('LINESTRING')) return 'line';
  if (upper.includes('POLYGON')) return 'polygon';
  return upper.includes('GEOMETRYCOLLECTION') ? 'mixed' : 'unknown';
}

/**
 * IEngine implementation backed by DuckDB-WASM with the spatial
 * extension, lazy-loaded from jsDelivr.
 */
export class DuckDBEngine implements IEngine {
  private _loaded: LoadedDuckDB;
  private _queue = new QueryQueue();
  private _tables = new Map<string, TableMeta>();
  /**
   * Registered virtual file per Blob, so a multi-layer file ingested
   * several times (once per layer) is uploaded into the WASM FS once.
   * Shared files live until dispose; only per-table object URLs are
   * released with their table.
   */
  private _sharedFiles = new Map<Blob, string>();

  /**
   * Creates an engine wrapper over a loaded DuckDB instance.
   *
   * @param loaded - The loaded database and connection
   */
  constructor(loaded: LoadedDuckDB) {
    this._loaded = loaded;
  }

  /** Whether the loaded build supports native ST_AsMVT tiles. */
  get supportsMVT(): boolean {
    return this._loaded.supportsMVT;
  }

  /** DuckDB core version string. */
  get version(): string {
    return this._loaded.version;
  }

  /** @inheritdoc */
  ingest(
    source: string | File | Blob,
    tableName: string,
    options: IngestOptions,
  ): Promise<IngestSummary> {
    return this._queue.enqueue(async () => {
      const meta: TableMeta = { propertyColumns: [], prepared: false };
      const byteSize =
        typeof Blob !== 'undefined' && source instanceof Blob ? source.size : undefined;

      const path = await this._registerSource(source, tableName, options);
      try {
        await this._createTable(tableName, path, options);
      } catch (err) {
        // ST_Read on registered buffers fails on some builds; retry local
        // files through an object URL the worker can fetch.
        const retried = await this._retryWithObjectUrl(err, source, tableName, options, meta);
        if (!retried) throw err;
      }

      const columns = await this._describeTable(tableName);
      meta.propertyColumns = columns
        .filter((c) => c.type !== 'GEOMETRY' && c.name !== 'geom_3857')
        .map((c) => c.name);
      this._tables.set(tableName, meta);

      const summary = await this._summarize(tableName);
      return { ...summary, tableName, byteSize };
    });
  }

  /** @inheritdoc */
  exportGeoJSON(tableName: string): Promise<FeatureCollection> {
    return this._queue.enqueue(async () => {
      const meta = this._requireTable(tableName);
      const result = await this._loaded.conn.query(
        exportGeoJSONQuery(tableName, meta.propertyColumns),
      );
      const features: Feature[] = result.toArray().map((row) => {
        const geometry = JSON.parse(String(row.__geojson)) as Geometry;
        const properties: Record<string, unknown> = {};
        for (const column of meta.propertyColumns) {
          properties[column] = sanitizeValue(row[column]);
        }
        return { type: 'Feature', geometry, properties };
      });
      return { type: 'FeatureCollection', features };
    });
  }

  /** @inheritdoc */
  prepareTiles(tableName: string): Promise<void> {
    return this._queue.enqueue(async () => {
      const meta = this._requireTable(tableName);
      if (meta.prepared) return;

      const statements = prepareTilesSql(tableName);
      for (const statement of statements.transform) {
        await this._loaded.conn.query(statement);
      }
      try {
        await this._loaded.conn.query(statements.index);
      } catch {
        // R-Tree support varies across builds; tiles still work via scans.
      }
      meta.prepared = true;
    });
  }

  /** @inheritdoc */
  getTile(
    tableName: string,
    layerName: string,
    z: number,
    x: number,
    y: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    return this._queue.enqueue(async () => {
      const meta = this._requireTable(tableName);

      if (this._loaded.supportsMVT) {
        const result = await this._loaded.conn.query(
          mvtTileQuery(tableName, layerName, z, x, y, meta.propertyColumns),
        );
        const value = result.toArray()[0]?.tile as Uint8Array | null | undefined;
        // Copy out of WASM-backed memory before handing to MapLibre.
        return value ? new Uint8Array(value) : new Uint8Array(0);
      }

      // Fallback: query intersecting features and encode the tile in JS.
      const bbox = tileBbox4326(z, x, y, 64 / 4096);
      const result = await this._loaded.conn.query(
        tileFeaturesQuery(tableName, bbox, meta.propertyColumns),
      );
      const features: Feature[] = result.toArray().map((row) => {
        const geometry = JSON.parse(String(row.__geojson)) as Geometry;
        const properties: Record<string, unknown> = {};
        for (const column of meta.propertyColumns) {
          properties[column] = sanitizeValue(row[column]);
        }
        return { type: 'Feature', geometry, properties };
      });
      return encodeTileFromFeatures(features, layerName, z, x, y);
    }, signal);
  }

  /** @inheritdoc */
  dropTable(tableName: string): Promise<void> {
    return this._queue.enqueue(async () => {
      const meta = this._tables.get(tableName);
      await this._loaded.conn.query(`DROP TABLE IF EXISTS ${quoteIdent(tableName)}`);
      // Shared registered files are NOT dropped here: another table
      // ingested from the same Blob may still read them. They are
      // released when the engine is disposed.
      if (meta?.objectUrl) {
        URL.revokeObjectURL(meta.objectUrl);
      }
      this._tables.delete(tableName);
    });
  }

  /** @inheritdoc */
  async dispose(): Promise<void> {
    for (const meta of this._tables.values()) {
      if (meta.objectUrl) URL.revokeObjectURL(meta.objectUrl);
    }
    this._tables.clear();
    for (const name of this._sharedFiles.values()) {
      await this._loaded.db.dropFile(name).catch(() => undefined);
    }
    this._sharedFiles.clear();
    await this._loaded.conn.close().catch(() => undefined);
    await this._loaded.db.terminate().catch(() => undefined);
  }

  /**
   * Registers a source with the database and returns the path readers
   * should use. URLs pass through untouched.
   */
  private async _registerSource(
    source: string | File | Blob,
    registrationName: string,
    options: IngestOptions,
  ): Promise<string> {
    if (typeof source === 'string') return source;

    const shared = this._sharedFiles.get(source);
    if (shared) return shared;

    const extension = options.fileName?.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'bin';
    const name = `${registrationName}.${extension.toLowerCase()}`;
    const buffer = new Uint8Array(await source.arrayBuffer());
    await this._loaded.db.registerFileBuffer(name, buffer);
    this._sharedFiles.set(source, name);
    return name;
  }

  /** @inheritdoc */
  listLayers(
    source: string | File | Blob,
    registrationName: string,
    options: IngestOptions,
  ): Promise<string[]> {
    return this._queue.enqueue(async () => {
      try {
        const path = await this._registerSource(source, registrationName, options);
        const result = await this._loaded.conn.query(
          layersMetaQuery(gdalPath(options.format, path)),
        );
        return result.toArray().map((row) => String(row.name));
      } catch {
        // Not a GDAL-readable container (or meta unsupported);
        // treat as single-layer.
        return [];
      }
    });
  }

  /**
   * Creates the ingest table from a registered path, normalizing the
   * geometry column to `geom` and handling CSV WKT/lon-lat layouts.
   */
  private async _createTable(
    tableName: string,
    path: string,
    options: IngestOptions,
  ): Promise<void> {
    const reader = readerFor(options.format, gdalPath(options.format, path), options.sourceLayer);
    const columns = await this._describeReader(reader);

    const geometryColumn = columns.find((c) => c.type === 'GEOMETRY')?.name;
    if (geometryColumn) {
      await this._loaded.conn.query(createTableSql(tableName, reader, geometryColumn));
      return;
    }

    if (options.format === 'csv') {
      const lower = new Map(columns.map((c) => [c.name.toLowerCase(), c.name]));
      const wktName = WKT_COLUMN_NAMES.map((n) => lower.get(n)).find(Boolean);
      if (wktName) {
        await this._loaded.conn.query(createTableFromWktSql(tableName, reader, wktName));
        return;
      }
      for (const [lon, lat] of LON_LAT_COLUMN_PAIRS) {
        const lonName = lower.get(lon);
        const latName = lower.get(lat);
        if (lonName && latName) {
          await this._loaded.conn.query(
            createTableFromLonLatSql(tableName, reader, lonName, latName),
          );
          return;
        }
      }
      throw new Error(
        'CSV has no recognizable geometry: expected a WKT column ' +
          `(${WKT_COLUMN_NAMES.join(', ')}) or longitude/latitude columns`,
      );
    }

    throw new Error(`No geometry column found in source (format: ${options.format})`);
  }

  /**
   * Retries table creation through an object URL when reading a
   * registered buffer failed (older builds cannot ST_Read virtual
   * files).
   *
   * @returns True when the retry succeeded
   */
  private async _retryWithObjectUrl(
    _error: unknown,
    source: string | File | Blob,
    tableName: string,
    options: IngestOptions,
    meta: TableMeta,
  ): Promise<boolean> {
    if (typeof source === 'string' || !(source instanceof Blob)) return false;
    if (options.format === 'geoparquet' || options.format === 'csv') return false;

    const objectUrl = URL.createObjectURL(source);
    try {
      await this._createTable(tableName, objectUrl, options);
      meta.objectUrl = objectUrl;
      return true;
    } catch {
      URL.revokeObjectURL(objectUrl);
      return false;
    }
  }

  /**
   * Describes the columns a reader expression produces.
   */
  private async _describeReader(reader: string): Promise<ColumnInfo[]> {
    const result = await this._loaded.conn.query(columnsQueryFromDescribe(reader));
    return result.toArray().map((row) => ({
      name: String(row.column_name),
      type: String(row.column_type),
    }));
  }

  /**
   * Describes the columns of an existing table.
   */
  private async _describeTable(tableName: string): Promise<ColumnInfo[]> {
    return this._describeReader(quoteIdent(tableName));
  }

  /**
   * Computes feature count, extent, and geometry category of a table.
   */
  private async _summarize(
    tableName: string,
  ): Promise<Omit<IngestSummary, 'tableName' | 'byteSize'>> {
    const summaryResult = await this._loaded.conn.query(summaryQuery(tableName));
    const row = summaryResult.toArray()[0] ?? {};
    const featureCount = Number(row.feature_count ?? 0);

    let bbox: Bbox | undefined;
    const coords = [row.xmin, row.ymin, row.xmax, row.ymax].map((v) => Number(v));
    if (coords.every((v) => Number.isFinite(v))) {
      bbox = coords as Bbox;
    }

    let geometryType: GeometryCategory = 'unknown';
    const typesResult = await this._loaded.conn.query(geometryTypesQuery(tableName));
    for (const typeRow of typesResult.toArray()) {
      geometryType = mergeGeometryCategory(
        geometryType === 'unknown' ? undefined : geometryType,
        categoryFromTypeName(String(typeRow.geometry_type)),
      );
    }

    return { featureCount, bbox, geometryType };
  }

  private _requireTable(tableName: string): TableMeta {
    const meta = this._tables.get(tableName);
    if (!meta) {
      throw new Error(`Unknown table: ${tableName}`);
    }
    return meta;
  }
}

/**
 * Loads DuckDB-WASM from the CDN and creates the engine.
 *
 * @param options - Engine creation options
 * @returns The ready engine
 */
export async function createEngine(options?: CreateEngineOptions): Promise<IEngine> {
  const loaded = await loadDuckDB(options?.onProgress);
  options?.onProgress?.(`DuckDB ${loaded.version} ready`);
  return new DuckDBEngine(loaded);
}
