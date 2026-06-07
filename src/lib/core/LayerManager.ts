import type { Map as MapLibreMap } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import type {
  RenderMode,
  VectorControlEvent,
  VectorControlOptions,
  VectorDataSource,
  VectorLayerInfo,
  VectorLayerOptions,
  VectorLayerStyle,
} from './types';
import type { EngineProvider } from '../engine/types';
import { detectSource } from '../formats/detect';
import { decideRenderMode } from '../render/renderMode';
import { DEFAULT_STYLE, applyStyle } from '../render/styleBuilder';
import {
  addGeoJSONSource,
  addGeometryLayers,
  addVectorTileSource,
  removeLayersAndSource,
  setLayersVisibility,
  sourceIdFor,
} from '../render/mapSources';
import { registerTileProvider, tileUrlFor, unregisterTileProvider } from '../tiles/protocol';
import { summarizeFeatureCollection, toFeatureCollection } from '../utils/geometry';
import { generateId } from '../utils/helpers';

/**
 * Emits a control event with optional layer/error context.
 */
export type LayerManagerEmitter = (
  type: VectorControlEvent,
  extra?: { layer?: VectorLayerInfo; error?: Error; message?: string },
) => void;

/**
 * Dependencies injected into the layer manager.
 */
export interface LayerManagerDeps {
  map: MapLibreMap;
  options: VectorControlOptions;
  emit: LayerManagerEmitter;
  getEngine: EngineProvider;
}

interface LayerRecord {
  info: VectorLayerInfo;
  source: VectorDataSource;
  sourceLayer?: string;
  fileName?: string;
  /** Set once the source has been ingested into the engine */
  tableName?: string;
  /**
   * Globally unique key in the duckdb:// provider registry. Distinct
   * from the public layer id, which can repeat across controls.
   */
  providerKey?: string;
}

const DEFAULT_MAX_TILE_ZOOM = 16;

/**
 * Builds a SQL-safe table name from a layer id.
 *
 * @param layerId - The vector layer id
 * @returns A sanitized table name
 */
export function tableNameFor(layerId: string): string {
  return `t_${layerId}`.replace(/[^a-zA-Z0-9_]/g, '_');
}

/**
 * Owns the vector layers of a control: loading data, creating map
 * sources/layers, visibility, styling, render-mode switching, and
 * cleanup. Communicates with DuckDB only through the injected engine
 * provider, which is resolved lazily on first non-GeoJSON load.
 */
export class LayerManager {
  private _map: MapLibreMap;
  private _options: VectorControlOptions;
  private _emit: LayerManagerEmitter;
  private _getEngine: EngineProvider;
  private _records = new Map<string, LayerRecord>();

  /**
   * Creates a layer manager.
   *
   * @param deps - Injected dependencies
   */
  constructor(deps: LayerManagerDeps) {
    this._map = deps.map;
    this._options = deps.options;
    this._emit = deps.emit;
    this._getEngine = deps.getEngine;
  }

  /**
   * Returns metadata for all loaded layers.
   */
  getLayers(): VectorLayerInfo[] {
    return Array.from(this._records.values(), (record) => ({ ...record.info }));
  }

  /**
   * Returns metadata for a single layer.
   *
   * @param id - The layer id
   */
  getLayer(id: string): VectorLayerInfo | undefined {
    const record = this._records.get(id);
    return record ? { ...record.info } : undefined;
  }

  /**
   * Loads a data source and adds it to the map.
   *
   * @param source - URL string, File/Blob, or GeoJSON object
   * @param options - Layer options
   * @returns Metadata of the added layer
   */
  async addData(
    source: VectorDataSource,
    options: VectorLayerOptions = {},
  ): Promise<VectorLayerInfo> {
    const detected = detectSource(source, options.format);
    const id = options.id ?? generateId('vector');
    if (this._records.has(id)) {
      throw new Error(`Layer "${id}" already exists`);
    }

    const name = options.name ?? detected.name;
    const style: VectorLayerStyle = { ...DEFAULT_STYLE, ...options.style };
    const visible = options.visible ?? true;

    const record: LayerRecord = {
      info: {
        id,
        name,
        format: detected.format,
        renderMode: 'geojson',
        geometryType: 'unknown',
        visible,
        style,
        sourceId: sourceIdFor(id),
        layerIds: [],
      },
      source,
      sourceLayer: options.sourceLayer,
      fileName: typeof File !== 'undefined' && source instanceof File ? source.name : undefined,
    };

    this._emit('loading', { message: `Loading ${name}...` });

    try {
      if (detected.format === 'geojson' && options.renderMode !== 'tiles') {
        await this._addGeoJSON(record, options);
      } else {
        await this._addViaEngine(record, options);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this._emit('error', { error });
      throw error;
    }

    this._records.set(id, record);
    if ((options.fitBounds ?? true) && record.info.bbox) {
      this._fitBounds(record.info.bbox);
    }
    this._emit('layeradded', { layer: { ...record.info } });
    return { ...record.info };
  }

  /**
   * Removes a layer from the map and the engine.
   *
   * @param id - The layer id
   */
  removeLayer(id: string): void {
    const record = this._records.get(id);
    if (!record) return;

    removeLayersAndSource(this._map, record.info.layerIds, record.info.sourceId);
    if (record.providerKey) unregisterTileProvider(record.providerKey);
    if (record.tableName) {
      const tableName = record.tableName;
      this._getEngine()
        .then((engine) => engine.dropTable(tableName))
        .catch(() => {
          // The engine is already gone or never loaded; nothing to clean up.
        });
    }
    this._records.delete(id);
    this._emit('layerremoved', { layer: { ...record.info } });
  }

  /**
   * Removes all layers.
   */
  removeAll(): void {
    for (const id of Array.from(this._records.keys())) {
      this.removeLayer(id);
    }
  }

  /**
   * Shows or hides a layer.
   *
   * @param id - The layer id
   * @param visible - Whether the layer should be visible
   */
  setLayerVisibility(id: string, visible: boolean): void {
    const record = this._records.get(id);
    if (!record || record.info.visible === visible) return;
    setLayersVisibility(this._map, record.info.layerIds, visible);
    record.info.visible = visible;
    this._emit('layerupdated', { layer: { ...record.info } });
  }

  /**
   * Zooms the map to a layer's extent.
   *
   * @param id - The layer id
   */
  zoomToLayer(id: string): void {
    const record = this._records.get(id);
    if (!record?.info.bbox) return;
    this._fitBounds(record.info.bbox);
  }

  /**
   * Applies a style patch to a layer.
   *
   * @param id - The layer id
   * @param patch - Partial style update
   */
  setLayerStyle(id: string, patch: Partial<VectorLayerStyle>): void {
    const record = this._records.get(id);
    if (!record) return;
    applyStyle(this._map, record.info, patch);
    record.info.style = { ...record.info.style, ...patch };
    this._emit('layerupdated', { layer: { ...record.info } });
  }

  /**
   * Switches a layer between GeoJSON and dynamic tile rendering.
   *
   * @param id - The layer id
   * @param mode - The requested render mode
   */
  async setRenderMode(id: string, mode: RenderMode): Promise<void> {
    const record = this._records.get(id);
    if (!record) return;

    const target = decideRenderMode({
      requested: mode,
      defaultMode: this._options.defaultRenderMode,
      featureCount: record.info.featureCount,
      byteSize: record.info.byteSize,
      threshold: this._options.autoThreshold,
    });
    if (target === record.info.renderMode) return;

    this._emit('loading', { message: `Switching ${record.info.name} to ${target}...` });

    try {
      removeLayersAndSource(this._map, record.info.layerIds, record.info.sourceId);
      if (record.providerKey) unregisterTileProvider(record.providerKey);
      record.info.layerIds = [];

      if (target === 'tiles') {
        await this._presentTiles(record);
      } else {
        await this._presentGeoJSON(record);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this._emit('error', { error });
      throw error;
    }

    this._emit('layerupdated', { layer: { ...record.info } });
  }

  /**
   * Removes all layers and map resources without emitting events.
   * Called when the control is removed from the map.
   */
  dispose(): void {
    for (const record of this._records.values()) {
      removeLayersAndSource(this._map, record.info.layerIds, record.info.sourceId);
      if (record.providerKey) unregisterTileProvider(record.providerKey);
    }
    this._records.clear();
  }

  /**
   * Loads a GeoJSON source entirely in JavaScript (no DuckDB), falling
   * back to the engine when auto mode trips the size thresholds.
   */
  private async _addGeoJSON(record: LayerRecord, options: VectorLayerOptions): Promise<void> {
    const { collection, byteSize } = await this._resolveGeoJSON(record.source);
    const summary = summarizeFeatureCollection(collection);

    record.info.featureCount = summary.featureCount;
    record.info.byteSize = byteSize;
    record.info.bbox = summary.bbox;
    record.info.geometryType = summary.geometryType;

    const mode = decideRenderMode({
      requested: options.renderMode,
      defaultMode: this._options.defaultRenderMode,
      featureCount: summary.featureCount,
      byteSize,
      threshold: this._options.autoThreshold,
    });

    if (mode === 'tiles') {
      await this._presentTiles(record);
      return;
    }

    record.info.renderMode = 'geojson';
    addGeoJSONSource(this._map, record.info.id, collection, this._options.attribution);
    record.info.layerIds = addGeometryLayers(this._map, {
      layerId: record.info.id,
      geometryType: summary.geometryType,
      style: record.info.style,
      visible: record.info.visible,
    });
  }

  /**
   * Loads a source through the DuckDB engine and presents it as GeoJSON
   * or dynamic tiles based on the resolved render mode.
   */
  private async _addViaEngine(record: LayerRecord, options: VectorLayerOptions): Promise<void> {
    const summary = await this._ingest(record);

    record.info.featureCount = summary.featureCount;
    record.info.byteSize = summary.byteSize ?? record.info.byteSize;
    record.info.bbox = summary.bbox;
    record.info.geometryType = summary.geometryType;

    const mode = decideRenderMode({
      requested: options.renderMode,
      defaultMode: this._options.defaultRenderMode,
      featureCount: summary.featureCount,
      byteSize: record.info.byteSize,
      threshold: this._options.autoThreshold,
    });

    if (mode === 'tiles') {
      await this._presentTiles(record);
    } else {
      await this._presentGeoJSON(record);
    }
  }

  /**
   * Ingests the record's source into the engine, reusing an existing
   * table when present.
   */
  private async _ingest(record: LayerRecord) {
    const engine = await this._getEngine();
    const tableName = tableNameFor(record.info.id);
    const source = await this._engineSource(record.source);
    const summary = await engine.ingest(source, tableName, {
      format: record.info.format,
      sourceLayer: record.sourceLayer,
      fileName: record.fileName ?? this._defaultFileName(record),
    });
    record.tableName = summary.tableName;
    return summary;
  }

  /**
   * Presents a record as a dynamic tile layer, ingesting it first when
   * needed.
   */
  private async _presentTiles(record: LayerRecord): Promise<void> {
    const engine = await this._getEngine();
    if (!record.tableName) {
      const summary = await this._ingest(record);
      record.info.featureCount = summary.featureCount;
      record.info.bbox = summary.bbox ?? record.info.bbox;
      record.info.geometryType =
        summary.geometryType !== 'unknown' ? summary.geometryType : record.info.geometryType;
    }
    const tableName = record.tableName!;
    await engine.prepareTiles(tableName);

    const id = record.info.id;
    // The provider registry is process-wide; key it by a generated
    // unique value so equal layer ids on two controls cannot collide.
    const providerKey = record.providerKey ?? generateId(`${id}-tiles`);
    record.providerKey = providerKey;
    await registerTileProvider(providerKey, (z, x, y, signal) =>
      engine.getTile(tableName, id, z, x, y, signal),
    );

    record.info.renderMode = 'tiles';
    addVectorTileSource(this._map, id, {
      tileUrl: tileUrlFor(providerKey),
      maxzoom: this._options.maxTileZoom ?? DEFAULT_MAX_TILE_ZOOM,
      bounds: record.info.bbox,
      attribution: this._options.attribution,
    });
    record.info.layerIds = addGeometryLayers(this._map, {
      layerId: id,
      geometryType: record.info.geometryType,
      style: record.info.style,
      visible: record.info.visible,
      sourceLayer: id,
    });
  }

  /**
   * Presents a record as a GeoJSON layer, exporting from the engine when
   * the source was ingested, or re-parsing the original source.
   */
  private async _presentGeoJSON(record: LayerRecord): Promise<void> {
    let collection: FeatureCollection;
    if (record.tableName) {
      const engine = await this._getEngine();
      collection = await engine.exportGeoJSON(record.tableName);
    } else {
      collection = (await this._resolveGeoJSON(record.source)).collection;
    }

    if (record.info.geometryType === 'unknown') {
      record.info.geometryType = summarizeFeatureCollection(collection).geometryType;
    }

    record.info.renderMode = 'geojson';
    addGeoJSONSource(this._map, record.info.id, collection, this._options.attribution);
    record.info.layerIds = addGeometryLayers(this._map, {
      layerId: record.info.id,
      geometryType: record.info.geometryType,
      style: record.info.style,
      visible: record.info.visible,
    });
  }

  /**
   * Resolves a data source to a FeatureCollection without DuckDB.
   */
  private async _resolveGeoJSON(
    source: VectorDataSource,
  ): Promise<{ collection: FeatureCollection; byteSize?: number }> {
    if (typeof source === 'string') {
      const response = await fetch(source);
      if (!response.ok) {
        throw new Error(`Failed to fetch ${source}: ${response.status} ${response.statusText}`);
      }
      const text = await response.text();
      return { collection: toFeatureCollection(JSON.parse(text)), byteSize: text.length };
    }

    if (typeof Blob !== 'undefined' && source instanceof Blob) {
      const text = await source.text();
      return { collection: toFeatureCollection(JSON.parse(text)), byteSize: source.size };
    }

    return { collection: toFeatureCollection(source as Exclude<VectorDataSource, string | Blob>) };
  }

  /**
   * Converts a data source to something the engine can register
   * (GeoJSON objects become Blobs).
   */
  private async _engineSource(source: VectorDataSource): Promise<string | File | Blob> {
    if (typeof source === 'string') return source;
    if (typeof Blob !== 'undefined' && source instanceof Blob) return source;
    return new Blob([JSON.stringify(source)], { type: 'application/geo+json' });
  }

  /**
   * Picks a registration file name for sources without one.
   */
  private _defaultFileName(record: LayerRecord): string {
    const ext = record.info.format === 'geojson' ? 'geojson' : 'bin';
    return `${tableNameFor(record.info.id)}.${ext}`;
  }

  private _fitBounds(bbox: [number, number, number, number]): void {
    this._map.fitBounds(
      [
        [bbox[0], bbox[1]],
        [bbox[2], bbox[3]],
      ],
      { padding: 40, duration: 600, maxZoom: 16 },
    );
  }
}
