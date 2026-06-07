import type { FeatureCollection } from 'geojson';
import type { GeometryCategory, IngestMode, VectorFormat } from '../core/types';
import type { Bbox } from '../utils/geometry';

/**
 * Options for ingesting a data source into the engine.
 */
export interface IngestOptions {
  /** Detected or explicit source format */
  format: VectorFormat;
  /** Named layer inside multi-layer containers (e.g. a GeoPackage table) */
  sourceLayer?: string;
  /** Original file name, used to pick a registration name */
  fileName?: string;
  /** Requested ingest mode (streaming applies to GeoParquet only) */
  mode?: IngestMode;
}

/**
 * Summary returned after ingesting a source into a table.
 */
export interface IngestSummary {
  /** Name of the created table */
  tableName: string;
  /** Number of features ingested */
  featureCount: number;
  /** Extent in EPSG:4326 */
  bbox?: Bbox;
  /** Broad geometry category */
  geometryType: GeometryCategory;
  /** Source size in bytes, when known */
  byteSize?: number;
  /** Whether the source is streamed in place instead of materialized */
  streamed?: boolean;
}

/**
 * Engine abstraction over DuckDB-WASM with the spatial extension.
 *
 * The interface exists so the layer manager can be unit tested with a
 * mock engine; the real implementation lazy-loads DuckDB from a CDN.
 */
export interface IEngine {
  /**
   * Loads a data source into a new table.
   *
   * @param source - URL string, File, or Blob
   * @param tableName - Name of the table to create
   * @param options - Ingest options
   * @returns Summary of the ingested data
   */
  ingest(source: string | File | Blob, tableName: string, options: IngestOptions): Promise<IngestSummary>;

  /**
   * Lists the named layers inside a multi-layer container (GeoPackage
   * tables, KML folders, ...).
   *
   * @param source - URL string, File, or Blob
   * @param registrationName - Virtual file name used when registering
   * @param options - Ingest options (format, fileName)
   * @returns Layer names; empty for single-layer or unreadable sources
   */
  listLayers(
    source: string | File | Blob,
    registrationName: string,
    options: IngestOptions,
  ): Promise<string[]>;

  /**
   * Exports a table to a GeoJSON FeatureCollection (EPSG:4326).
   *
   * @param tableName - The table to export
   * @returns The FeatureCollection
   */
  exportGeoJSON(tableName: string): Promise<FeatureCollection>;

  /**
   * Prepares a table for dynamic tile generation (Web Mercator geometry
   * column and spatial index).
   *
   * @param tableName - The table to prepare
   */
  prepareTiles(tableName: string): Promise<void>;

  /**
   * Generates an MVT tile for a table.
   *
   * @param tableName - The source table
   * @param layerName - MVT layer name (must match the map source-layer)
   * @param z - Tile zoom
   * @param x - Tile column
   * @param y - Tile row
   * @param signal - Optional abort signal honored while queued
   * @returns The encoded tile (empty when no features intersect)
   */
  getTile(
    tableName: string,
    layerName: string,
    z: number,
    x: number,
    y: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;

  /**
   * Drops a table created by ingest.
   *
   * @param tableName - The table to drop
   */
  dropTable(tableName: string): Promise<void>;

  /**
   * Terminates the engine and releases the worker.
   */
  dispose(): Promise<void>;
}

/**
 * Lazily resolves the shared engine instance, loading DuckDB on first use.
 */
export type EngineProvider = () => Promise<IEngine>;
