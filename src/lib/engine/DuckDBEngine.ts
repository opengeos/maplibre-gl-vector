import type { Feature, FeatureCollection, Geometry } from "geojson";
import type { GeometryCategory } from "../core/types";
import type { IEngine, IngestOptions, IngestSummary } from "./types";
import type { Bbox } from "../utils/geometry";
import { mergeGeometryCategory } from "../utils/geometry";
import { loadDuckDB, type LoadedDuckDB } from "./duckdbLoader";
import { ensureGpkgFeatureCount } from "./gpkgOgrContents";
import { listGeoPackageLayers, readGeoPackage } from "./geopackage";
import { encodeTileFromFeatures, tileBbox4326 } from "../tiles/mvtFallback";
import { assertRemoteFileSupported, probeRemoteSize } from "../utils/remote";
import {
  LON_LAT_COLUMN_PAIRS,
  WKT_COLUMN_NAMES,
  bboxSummaryQuery,
  columnsQueryFromDescribe,
  createTableFromLonLatSql,
  createTableFromWktSql,
  createTableFromGeometrySql,
  createViewFromGeometrySql,
  detectGeometryColumn,
  exportGeoJSONQuery,
  gdalPath,
  geometryTypesQuery,
  isBboxCoveringColumn,
  keepWkbReaderFor,
  layersMetaQuery,
  mvtTileQuery,
  mvtTileStreamQuery,
  prepareTilesSql,
  quoteIdent,
  quoteLiteral,
  readerFor,
  sampledGeometryTypesQuery,
  sourceCrsMetaQuery,
  summaryQuery,
  tileFeaturesQuery,
  type DetectedGeometryColumn,
} from "./sql";
import {
  registerLooseShapefile,
  registerZippedShapefile,
} from "../formats/shapefile";
import {
  isUnsupportedSurfaceWkbError,
  wkbRowsToFeatureCollection,
} from "./surfaceWkb";

/**
 * Whether an `AUTHORITY:CODE` CRS string names WGS84 lon/lat, for which
 * reprojection to EPSG:4326 is a no-op: EPSG:4326 (2D), EPSG:4979 (3D geographic,
 * same lat/lon), and OGC:CRS84 (lon/lat order). Skipping the transform for these
 * keeps the common already-WGS84 case cheap.
 *
 * @param crs - An `AUTHORITY:CODE` CRS string
 * @returns True when the CRS is WGS84 lon/lat
 */
function isWgs84AuthCrs(crs: string): boolean {
  switch (crs.toUpperCase()) {
    case "EPSG:4326":
    case "EPSG:4979":
    case "OGC:CRS84":
      return true;
    default:
      return false;
  }
}

/**
 * Options for creating the DuckDB engine.
 */
export interface CreateEngineOptions {
  /** Progress message callback (e.g. for the panel status line) */
  onProgress?: (message: string) => void;
  /**
   * Base URL to load duckdb-wasm from instead of jsDelivr. See
   * {@link loadDuckDB}.
   */
  baseUrl?: string;
  /**
   * Base URL to load sql.js from instead of jsDelivr. sql.js is used to repair
   * GeoPackages missing `gpkg_ogr_contents` before reading. See
   * {@link ensureGpkgFeatureCount}.
   */
  sqlJsBaseUrl?: string;
  /**
   * Path/URL to a prebuilt spatial extension. When set, the remote
   * `INSTALL spatial` is skipped in favour of `LOAD '<path>'`. See
   * {@link loadDuckDB}.
   */
  spatialExtensionPath?: string;
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
        throw new DOMException("The operation was aborted.", "AbortError");
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
  /** Whether this is a streaming view rather than a table */
  streamed: boolean;
  /** GeoParquet bbox covering column, when present */
  bboxColumn?: string;
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
    case "bigint":
      return Number.isSafeInteger(Number(value))
        ? Number(value)
        : value.toString();
    case "number":
    case "string":
    case "boolean":
      return value;
    case "object":
      if (value instanceof Date) return value.toISOString();
      if (value instanceof Uint8Array) return null;
      try {
        return JSON.parse(
          JSON.stringify(value, (_key, v) =>
            typeof v === "bigint"
              ? Number.isSafeInteger(Number(v))
                ? Number(v)
                : v.toString()
              : v,
          ),
        );
      } catch {
        return String(value);
      }
    default:
      return String(value);
  }
}

function numberFromCount(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number(value);
  return 0;
}

/**
 * Maps a DuckDB ST_GeometryType value to a broad category.
 */
function categoryFromTypeName(name: string): GeometryCategory {
  const upper = name.toUpperCase();
  if (upper.includes("POINT")) return "point";
  if (upper.includes("LINESTRING")) return "line";
  if (upper.includes("POLYGON")) return "polygon";
  return upper.includes("GEOMETRYCOLLECTION") ? "mixed" : "unknown";
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
   * GeoPackage bytes per source, so the listLayers probe and the per-layer
   * ingest(s) of a multi-layer file each read the buffer (a local
   * `arrayBuffer()` or a remote fetch) only once.
   */
  private _geoPackageBytes = new Map<string | Blob, Promise<Uint8Array>>();
  /**
   * The `.prj` WKT of a registered zipped shapefile, keyed by its registered
   * `.shp` path. A zip carries no `companionFiles`, so this preserves its
   * projection for the reprojection fallback in {@link _createTable}.
   */
  private _prjWktByPath = new Map<string, string>();
  private _sqlJsBaseUrl?: string;

  /**
   * Creates an engine wrapper over a loaded DuckDB instance.
   *
   * @param loaded - The loaded database and connection
   * @param sqlJsBaseUrl - Optional sql.js base URL for the GeoPackage repair
   */
  constructor(loaded: LoadedDuckDB, sqlJsBaseUrl?: string) {
    this._loaded = loaded;
    this._sqlJsBaseUrl = sqlJsBaseUrl;
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
      const streamed =
        options.mode === "stream" && options.format === "geoparquet";
      const meta: TableMeta = {
        propertyColumns: [],
        prepared: false,
        streamed,
      };

      let byteSize: number | undefined;
      // GeoPackages are read with sql.js and reprojected through DuckDB, never
      // through GDAL's ST_Read, which hangs/crashes on the single-threaded WASM
      // build (see geopackage.ts).
      if (options.format === "geopackage" && !streamed) {
        const bytes = await this._geoPackageBytesFor(source);
        byteSize = bytes.byteLength;
        await this._createTableFromGeoPackage(tableName, bytes, options);
      } else {
        const path = await this._registerSource(source, tableName, options);
        byteSize =
          typeof Blob !== "undefined" && source instanceof Blob
            ? source.size
            : await probeRemoteSize(source as string);
        if (streamed) {
          await this._createStreamView(tableName, path, options);
        } else {
          try {
            await this._createTable(tableName, path, options);
          } catch (err) {
            // ST_Read on registered buffers fails on some builds; retry local
            // files through an object URL the worker can fetch.
            const retried = await this._retryWithObjectUrl(
              err,
              source,
              tableName,
              options,
              meta,
            );
            if (!retried) throw err;
          }
        }
      }

      const columns = await this._describeTable(tableName);
      meta.bboxColumn = columns.find((c) =>
        isBboxCoveringColumn(c.name, c.type),
      )?.name;
      meta.propertyColumns = columns
        .filter(
          (c) =>
            c.type !== "GEOMETRY" &&
            c.name !== "geom_3857" &&
            c.name !== meta.bboxColumn,
        )
        .map((c) => c.name);
      this._tables.set(tableName, meta);

      const summary = await this._summarize(tableName, meta);
      return { ...summary, tableName, byteSize, streamed };
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
        return { type: "Feature", geometry, properties };
      });
      return { type: "FeatureCollection", features };
    });
  }

  /** @inheritdoc */
  prepareTiles(tableName: string): Promise<void> {
    return this._queue.enqueue(async () => {
      const meta = this._requireTable(tableName);
      if (meta.prepared) return;

      // Streamed sources are queried in place per tile; there is no
      // table to transform or index.
      if (meta.streamed) {
        meta.prepared = true;
        return;
      }

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
        const query = meta.streamed
          ? mvtTileStreamQuery(
              tableName,
              layerName,
              z,
              x,
              y,
              tileBbox4326(z, x, y, 64 / 4096),
              meta.propertyColumns,
              meta.bboxColumn,
            )
          : mvtTileQuery(tableName, layerName, z, x, y, meta.propertyColumns);
        const result = await this._loaded.conn.query(query);
        const value = result.toArray()[0]?.tile as
          | Uint8Array
          | null
          | undefined;
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
        return { type: "Feature", geometry, properties };
      });
      return encodeTileFromFeatures(features, layerName, z, x, y);
    }, signal);
  }

  /** @inheritdoc */
  dropTable(tableName: string): Promise<void> {
    return this._queue.enqueue(async () => {
      const meta = this._tables.get(tableName);
      const kind = meta?.streamed ? "VIEW" : "TABLE";
      await this._loaded.conn.query(
        `DROP ${kind} IF EXISTS ${quoteIdent(tableName)}`,
      );
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
    this._geoPackageBytes.clear();
    this._prjWktByPath.clear();
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
    if (typeof source === "string") {
      // Defense in depth: the layer manager checks before loading the
      // engine; the shared cache makes this probe free.
      await assertRemoteFileSupported(source);
      return source;
    }

    const shared = this._sharedFiles.get(source);
    if (shared) return shared;

    const extension = options.fileName?.match(/\.([a-z0-9]+)$/i)?.[1] ?? "bin";
    const name = `${registrationName}.${extension.toLowerCase()}`;
    let buffer: Uint8Array = new Uint8Array(await source.arrayBuffer());

    // GeoPackages without gpkg_ogr_contents crash ST_Read on single-threaded
    // DuckDB-WASM; repair the buffer before registering it. See
    // gpkgOgrContents.ts.
    if (options.format === "geopackage") {
      buffer = await ensureGpkgFeatureCount(buffer, this._sqlJsBaseUrl);
    }

    // GDAL's /vsizip handler cannot read a DuckDB-WASM registerFileBuffer
    // archive (the virtual filesystem it opens through is GDAL's own, not
    // DuckDB's registered-file VFS), so a zipped shapefile is unzipped and its
    // components are registered individually; readers then open the .shp
    // directly rather than via /vsizip.
    if (options.format === "shapefile" && /\.zip$/i.test(name)) {
      const { shpPath, prjWkt } = await registerZippedShapefile(
        buffer,
        registrationName,
        (componentName, bytes) =>
          this._loaded.db.registerFileBuffer(componentName, bytes),
      );
      // A zip carries no `companionFiles`, so remember its `.prj` WKT keyed by
      // the registered path for the reprojection fallback in `_createTable`.
      if (prjWkt) this._prjWktByPath.set(shpPath, prjWkt);
      this._sharedFiles.set(source, shpPath);
      return shpPath;
    }

    // A loose `.shp` picked together with its sidecars (`.shx`, `.dbf`, ...):
    // register every component under one base name so GDAL resolves the
    // siblings when reading the `.shp` directly. Without this a lone `.shp`
    // fails with "GDALOpen() called on x.shp recursively".
    if (options.format === "shapefile" && options.companionFiles?.length) {
      const components = await Promise.all(
        options.companionFiles.map(async (file) => ({
          extension: file.name.slice(file.name.lastIndexOf(".")),
          bytes: new Uint8Array(await file.arrayBuffer()),
        })),
      );
      const shpPath = await registerLooseShapefile(
        buffer,
        components,
        registrationName,
        (componentName, bytes) =>
          this._loaded.db.registerFileBuffer(componentName, bytes),
      );
      this._sharedFiles.set(source, shpPath);
      return shpPath;
    }

    await this._loaded.db.registerFileBuffer(name, buffer);
    this._sharedFiles.set(source, name);
    return name;
  }

  /**
   * Reads a GeoPackage source's bytes once and caches them, so the listLayers
   * probe and each per-layer ingest of a multi-layer file share a single
   * `arrayBuffer()` (local) or fetch (remote).
   */
  private _geoPackageBytesFor(
    source: string | File | Blob,
  ): Promise<Uint8Array> {
    const cached = this._geoPackageBytes.get(source);
    if (cached) return cached;
    const bytes = (async () => {
      if (typeof source === "string") {
        await assertRemoteFileSupported(source);
        const response = await fetch(source);
        if (!response.ok) {
          throw new Error(
            `Failed to fetch GeoPackage (${response.status} ${response.statusText}).`,
          );
        }
        return new Uint8Array(await response.arrayBuffer());
      }
      return new Uint8Array(await source.arrayBuffer());
    })();
    // Drop a failed read from the cache so a later attempt can retry.
    bytes.catch(() => this._geoPackageBytes.delete(source));
    this._geoPackageBytes.set(source, bytes);
    return bytes;
  }

  /**
   * Creates the ingest table from a GeoPackage by reading it with sql.js into
   * GeoJSON, loading that through DuckDB's (unaffected) GeoJSON reader, and
   * reprojecting to EPSG:4326 with ST_Transform when the layer's CRS is not
   * already WGS84. Bypasses GDAL's GeoPackage driver entirely (see
   * geopackage.ts).
   */
  private async _createTableFromGeoPackage(
    tableName: string,
    bytes: Uint8Array,
    options: IngestOptions,
  ): Promise<void> {
    const { featureCollection, epsgCode } = await readGeoPackage(
      bytes,
      options.sourceLayer,
      this._sqlJsBaseUrl,
    );
    // ST_Read of an empty GeoJSON exposes no geometry column, so the EXCLUDE
    // below would fail; create an empty table with just `geom` instead.
    if (featureCollection.features.length === 0) {
      await this._loaded.conn.query(
        `CREATE OR REPLACE TABLE ${quoteIdent(tableName)} AS ` +
          `SELECT NULL::GEOMETRY AS geom WHERE false`,
      );
      return;
    }
    const geojsonName = `${tableName}.geojson`;
    await this._loaded.db.registerFileBuffer(
      geojsonName,
      new TextEncoder().encode(JSON.stringify(featureCollection)),
    );
    try {
      const reader = `ST_Read(${quoteLiteral(geojsonName)})`;
      // ST_Read exposes a GeoJSON's geometry as a native GEOMETRY column named
      // `geom`; reproject it to WGS84 when the GeoPackage stored another CRS so
      // the rest of the pipeline (tiles, export) can assume EPSG:4326.
      const geomExpr =
        epsgCode == null
          ? "geom"
          : `ST_Transform(geom, ${quoteLiteral(`EPSG:${epsgCode}`)}, 'EPSG:4326', always_xy := true)`;
      await this._loaded.conn.query(
        `CREATE OR REPLACE TABLE ${quoteIdent(tableName)} AS ` +
          `SELECT * EXCLUDE (geom), ${geomExpr} AS geom FROM ${reader}`,
      );
    } finally {
      await this._loaded.db.dropFile(geojsonName).catch(() => undefined);
    }
  }

  /** @inheritdoc */
  listLayers(
    source: string | File | Blob,
    registrationName: string,
    options: IngestOptions,
  ): Promise<string[]> {
    return this._queue.enqueue(async () => {
      try {
        // GeoPackages are listed with sql.js, not ST_Read_Meta: GDAL's
        // GeoPackage driver hangs/crashes on the single-threaded WASM build
        // (see geopackage.ts).
        if (options.format === "geopackage") {
          const bytes = await this._geoPackageBytesFor(source);
          return listGeoPackageLayers(bytes, this._sqlJsBaseUrl);
        }
        const path = await this._registerSource(
          source,
          registrationName,
          options,
        );
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
    const reader = readerFor(
      options.format,
      gdalPath(options.format, path),
      options.sourceLayer,
    );
    const columns = await this._describeReader(reader);

    const geometryColumn = await this._detectGeometryColumn(reader, columns);
    if (geometryColumn) {
      // Reproject the source geometry to WGS84 so the rest of the pipeline
      // (tiles, export) can assume EPSG:4326. GeoParquet is read via
      // read_parquet (not GDAL) and carries no ST_Read_Meta CRS, so it is left
      // in its source coordinates as before.
      const sourceCrs =
        options.format === "geoparquet"
          ? null
          : await this._readSourceCrs(
              gdalPath(options.format, path),
              await this._prjWkt(options, path),
            );
      try {
        await this._loaded.conn.query(
          createTableFromGeometrySql(tableName, reader, geometryColumn, sourceCrs),
        );
      } catch (error) {
        // DuckDB Spatial's WKB reader rejects surface geometries (TIN /
        // PolyhedralSurface), which its bundled GDAL emits for ESRI MultiPatch
        // shapefiles (3D buildings). Re-read the raw WKB and decode it in JS.
        // Only ST_Read formats can fall back this way (Parquet is read via
        // read_parquet, not GDAL), so those propagate the original error.
        if (options.format === "geoparquet" || !isUnsupportedSurfaceWkbError(error)) {
          throw error;
        }
        await this._createTableFromSurfaceWkb(tableName, path, options);
      }
      return;
    }

    if (options.format === "csv") {
      const lower = new Map(columns.map((c) => [c.name.toLowerCase(), c.name]));
      const wktName = WKT_COLUMN_NAMES.map((n) => lower.get(n)).find(Boolean);
      if (wktName) {
        await this._loaded.conn.query(
          createTableFromWktSql(tableName, reader, wktName),
        );
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
        "CSV has no recognizable geometry: expected a WKT column " +
          `(${WKT_COLUMN_NAMES.join(", ")}) or longitude/latitude columns`,
      );
    }

    throw new Error(
      `No geometry column found in source (format: ${options.format})`,
    );
  }

  /**
   * Creates the ingest table for a source whose geometry DuckDB Spatial cannot
   * materialize as a GEOMETRY value — TIN / PolyhedralSurface surfaces, the
   * encoding GDAL emits for ESRI MultiPatch shapefiles (3D buildings). The
   * geometry is re-read as raw WKB (`keep_wkb := true`), decoded to a
   * MultiPolygon in JS, then loaded back through DuckDB's GeoJSON reader (which
   * accepts the decoded MultiPolygon) and reprojected to WGS84 so the rest of
   * the pipeline (tiles, export) can assume EPSG:4326.
   */
  private async _createTableFromSurfaceWkb(
    tableName: string,
    path: string,
    options: IngestOptions,
  ): Promise<void> {
    const wkbReader = keepWkbReaderFor(path, options.sourceLayer);
    const columns = await this._describeReader(wkbReader);
    // `keep_wkb` materializes the geometry as a WKB blob column named
    // `wkb_geometry` (its DuckDB type varies by build: `BLOB` or `WKB_BLOB`), so
    // find it by that name, falling back to any WKB/BLOB-typed column.
    const wkbColumn =
      columns.find((column) => column.name.toLowerCase() === "wkb_geometry") ??
      columns.find((column) => /WKB|BLOB|BINARY/i.test(column.type));
    if (!wkbColumn) {
      throw new Error("No WKB geometry column found after re-reading raw WKB.");
    }
    const result = await this._loaded.conn.query(`SELECT * FROM ${wkbReader}`);
    const rows = result.toArray().map((row) => row as Record<string, unknown>);
    const featureCollection = wkbRowsToFeatureCollection(rows, wkbColumn.name);
    const sourceCrs = await this._readSourceCrs(
      gdalPath(options.format, path),
      await this._prjWkt(options, path),
    );

    const geojsonName = `${tableName}.surface.geojson`;
    await this._loaded.db.registerFileBuffer(
      geojsonName,
      new TextEncoder().encode(JSON.stringify(featureCollection)),
    );
    try {
      const reader = `ST_Read(${quoteLiteral(geojsonName)})`;
      // The decoded geometry is in the file's own CRS; reproject to WGS84 when a
      // source CRS was resolved (a `crs`-less GeoJSON reader leaves `geom` in the
      // source coordinates otherwise).
      const geomExpr = sourceCrs
        ? `ST_Transform(geom, ${quoteLiteral(sourceCrs)}, 'EPSG:4326', always_xy := true)`
        : "geom";
      await this._loaded.conn.query(
        `CREATE OR REPLACE TABLE ${quoteIdent(tableName)} AS ` +
          `SELECT * EXCLUDE (geom), ${geomExpr} AS geom FROM ${reader}`,
      );
    } finally {
      await this._loaded.db.dropFile(geojsonName).catch(() => undefined);
    }
  }

  /**
   * Resolves a source's CRS as a string `ST_Transform` accepts —
   * `AUTHORITY:CODE` when GDAL identified one, otherwise the raw WKT definition
   * (common for ESRI `.prj` files without an EPSG code), or null when the source
   * is already WGS84 or carries no usable CRS (so reprojection is skipped).
   *
   * `ST_Read_Meta` is tried first; when it cannot report the CRS the shapefile's
   * `.prj` sidecar (`prjWkt`) is the fallback. Some duckdb-wasm GDAL/PROJ builds
   * throw "cannot be formatted as WKT1 TOWGS84 parameters" for a datum whose
   * transform to WGS84 is grid-based rather than a 7-parameter shift (e.g.
   * OSGB36 / EPSG:27700), which fails the whole metadata query — the `.prj` text
   * still lets such a layer reproject.
   *
   * @param path - Registered file name the ST_Read_Meta query targets
   * @param prjWkt - The shapefile `.prj` sidecar WKT, or null when absent
   */
  private async _readSourceCrs(
    path: string,
    prjWkt: string | null = null,
  ): Promise<string | null> {
    try {
      const result = await this._loaded.conn.query(sourceCrsMetaQuery(path));
      const row = result.toArray()[0] as
        | { auth_name?: unknown; auth_code?: unknown; wkt?: unknown }
        | undefined;
      if (row) {
        const authName =
          typeof row.auth_name === "string" ? row.auth_name.trim() : "";
        const authCode =
          row.auth_code != null ? String(row.auth_code).trim() : "";
        if (authName && authCode) {
          const crs = `${authName.toUpperCase()}:${authCode}`;
          return isWgs84AuthCrs(crs) ? null : crs;
        }
        const wkt = typeof row.wkt === "string" ? row.wkt.trim() : "";
        if (wkt) return wkt;
      }
      // ST_Read_Meta reported no CRS: fall back to the `.prj` sidecar.
      return prjWkt?.trim() || null;
    } catch {
      // ST_Read_Meta could not materialize the CRS (see the OSGB36 note above).
      // The `.prj` sidecar still carries it; reprojection is otherwise skipped
      // and the layer loads in its source coordinates rather than failing.
      return prjWkt?.trim() || null;
    }
  }

  /**
   * The WKT text of a loose shapefile's `.prj` sidecar, read from
   * `options.companionFiles`, or null when this is not a shapefile with a
   * `.prj`. Used as the CRS fallback when `ST_Read_Meta` cannot report it.
   */
  private async _prjCompanionWkt(
    options: IngestOptions,
  ): Promise<string | null> {
    if (options.format !== "shapefile" || !options.companionFiles?.length) {
      return null;
    }
    const prj = options.companionFiles.find((file) =>
      file.name.toLowerCase().endsWith(".prj"),
    );
    if (!prj) return null;
    const text = (await prj.text()).trim();
    return text || null;
  }

  /**
   * The shapefile `.prj` WKT for the reprojection fallback: the loose
   * `companionFiles` sidecar, or the `.prj` remembered from a zipped shapefile
   * (keyed by its registered `.shp` path), or null when there is none.
   */
  private async _prjWkt(
    options: IngestOptions,
    path: string,
  ): Promise<string | null> {
    return (
      (await this._prjCompanionWkt(options)) ??
      this._prjWktByPath.get(path) ??
      null
    );
  }

  /**
   * Creates a streaming view over a GeoParquet reader instead of
   * materializing the data.
   */
  private async _createStreamView(
    tableName: string,
    path: string,
    options: IngestOptions,
  ): Promise<void> {
    const reader = readerFor(options.format, path, options.sourceLayer);
    const columns = await this._describeReader(reader);
    const geometryColumn = await this._detectGeometryColumn(reader, columns);
    if (!geometryColumn) {
      throw new Error("No geometry column found in GeoParquet source");
    }
    await this._loaded.conn.query(
      createViewFromGeometrySql(tableName, reader, geometryColumn),
    );
  }

  private async _detectGeometryColumn(
    reader: string,
    columns: ColumnInfo[],
  ): Promise<DetectedGeometryColumn | undefined> {
    const geometryColumn = detectGeometryColumn(columns);
    if (!geometryColumn?.requiresBase64WkbValidation) return geometryColumn;
    const candidates = geometryColumn.base64WkbCandidates?.length
      ? geometryColumn.base64WkbCandidates
      : [geometryColumn.name];
    for (const name of candidates) {
      if (await this._hasValidBase64WkbValues(reader, name)) {
        const {
          requiresBase64WkbValidation: _validated,
          base64WkbCandidates: _candidates,
          ...validated
        } = geometryColumn;
        return { ...validated, name };
      }
    }
    return undefined;
  }

  private async _hasValidBase64WkbValues(
    reader: string,
    column: string,
  ): Promise<boolean> {
    const columnSql = quoteIdent(column);
    const sampleColumn = quoteIdent("__maplibre_gl_vector_base64_wkb_sample");
    const result = await this._loaded.conn.query(
      `SELECT count(*) AS sample_count, ` +
        `count(TRY(ST_GeomFromWKB(from_base64(${sampleColumn})))) AS valid_count ` +
        `FROM (SELECT ${columnSql} AS ${sampleColumn} FROM ${reader} ` +
        `WHERE ${columnSql} IS NOT NULL LIMIT 20) AS sample`,
    );
    const row = result.toArray()[0] ?? {};
    const sampleCount = numberFromCount(row.sample_count);
    const validCount = numberFromCount(row.valid_count);
    return sampleCount > 0 && sampleCount === validCount;
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
    if (typeof source === "string" || !(source instanceof Blob)) return false;
    if (options.format === "geoparquet" || options.format === "csv")
      return false;

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
    const result = await this._loaded.conn.query(
      columnsQueryFromDescribe(reader),
    );
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
    meta: TableMeta,
  ): Promise<Omit<IngestSummary, "tableName" | "byteSize">> {
    // Streamed sources with a bbox covering column summarize from the
    // bbox stats instead of scanning every geometry.
    const summarySql =
      meta.streamed && meta.bboxColumn
        ? bboxSummaryQuery(tableName, meta.bboxColumn)
        : summaryQuery(tableName);
    const summaryResult = await this._loaded.conn.query(summarySql);
    const row = summaryResult.toArray()[0] ?? {};
    const featureCount = Number(row.feature_count ?? 0);

    let bbox: Bbox | undefined;
    const coords = [row.xmin, row.ymin, row.xmax, row.ymax].map((v) =>
      Number(v),
    );
    if (coords.every((v) => Number.isFinite(v))) {
      bbox = coords as Bbox;
    }

    let geometryType: GeometryCategory = "unknown";
    const typesSql = meta.streamed
      ? sampledGeometryTypesQuery(tableName)
      : geometryTypesQuery(tableName);
    const typesResult = await this._loaded.conn.query(typesSql);
    for (const typeRow of typesResult.toArray()) {
      geometryType = mergeGeometryCategory(
        geometryType === "unknown" ? undefined : geometryType,
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
export async function createEngine(
  options?: CreateEngineOptions,
): Promise<IEngine> {
  const loaded = await loadDuckDB(
    options?.onProgress,
    options?.baseUrl,
    options?.spatialExtensionPath,
  );
  options?.onProgress?.(`DuckDB ${loaded.version} ready`);
  return new DuckDBEngine(loaded, options?.sqlJsBaseUrl);
}
