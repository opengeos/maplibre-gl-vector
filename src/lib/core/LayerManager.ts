import type { Map as MapLibreMap, MapLayerMouseEvent } from 'maplibre-gl';
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
import { getMaplibre } from '../utils/maplibre';

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
  /** Per-map-layer picker handlers, for cleanup */
  pickerHandlers?: PickerHandler[];
}

interface PickerHandler {
  layerId: string;
  click: (e: MapLayerMouseEvent) => void;
  enter: () => void;
  leave: () => void;
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
  private _popup?: { remove(): void };
  private _popupOwnerId?: string;

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

    // Multi-layer containers (GeoPackage tables, KML folders, ...)
    // expand into one vector layer per source layer.
    const expanded = await this._maybeExpandLayers(source, options, detected, id);
    if (expanded) return expanded;

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
        picker: options.picker ?? this._options.enablePicker ?? true,
        ingestMode: options.ingestMode ?? this._options.defaultIngestMode ?? 'table',
        beforeId: options.beforeId ?? this._options.beforeId,
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

    this._detachPicker(record);
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
   * Enables or disables the attribute popup for a layer.
   *
   * @param id - The layer id
   * @param enabled - Whether clicking a feature opens a popup
   */
  setLayerPicker(id: string, enabled: boolean): void {
    const record = this._records.get(id);
    if (!record || record.info.picker === enabled) return;
    record.info.picker = enabled;
    this._detachPicker(record);
    if (enabled) this._attachPicker(record);
    this._emit('layerupdated', { layer: { ...record.info } });
  }

  /**
   * Moves a layer's map layers before another map layer (or to the top
   * when omitted).
   *
   * @param id - The layer id
   * @param beforeId - Target map layer id, or undefined for the top
   */
  setLayerBeforeId(id: string, beforeId?: string): void {
    const record = this._records.get(id);
    if (!record) return;
    const target = beforeId && this._map.getLayer(beforeId) ? beforeId : undefined;
    // Moving in creation order keeps the group's internal stacking.
    for (const layerId of record.info.layerIds) {
      this._map.moveLayer(layerId, target);
    }
    record.info.beforeId = target;
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
      this._detachPicker(record);
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
      this._detachPicker(record);
      removeLayersAndSource(this._map, record.info.layerIds, record.info.sourceId);
      if (record.providerKey) unregisterTileProvider(record.providerKey);
    }
    this._records.clear();
    this._popup?.remove();
    this._popup = undefined;
  }

  /**
   * Expands a multi-layer container into one vector layer per source
   * layer, when the source is engine-readable, no sourceLayer was
   * requested, and the container reports more than one layer.
   *
   * @returns The first created layer's info, or null when the source
   *   is single-layer (callers continue with the normal flow)
   */
  private async _maybeExpandLayers(
    source: VectorDataSource,
    options: VectorLayerOptions,
    detected: { format: VectorLayerInfo['format']; name: string },
    id: string,
  ): Promise<VectorLayerInfo | null> {
    // Single-layer by construction: native readers and the pure-JS
    // GeoJSON path. Explicit sourceLayer means the caller chose.
    const singleLayerFormats = ['geojson', 'geoparquet', 'csv'];
    if (options.sourceLayer || singleLayerFormats.includes(detected.format)) return null;

    const engine = await this._getEngine();
    const engineSource = await this._engineSource(source);
    const layerNames = await engine.listLayers(engineSource, tableNameFor(id), {
      format: detected.format,
      fileName:
        typeof File !== 'undefined' && source instanceof File ? source.name : undefined,
    });
    if (layerNames.length <= 1) return null;

    this._emit('loading', {
      message: `Loading ${layerNames.length} layers from ${options.name ?? detected.name}...`,
    });

    const infos: VectorLayerInfo[] = [];
    for (const layerName of layerNames) {
      const subId = `${id}-${layerName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      infos.push(
        await this.addData(source, {
          ...options,
          id: subId,
          name: layerName,
          sourceLayer: layerName,
          fitBounds: false,
        }),
      );
    }

    // Zoom once to the combined extent of all created layers.
    if (options.fitBounds ?? true) {
      const boxes = infos.map((info) => info.bbox).filter(Boolean) as Array<
        [number, number, number, number]
      >;
      if (boxes.length > 0) {
        this._fitBounds([
          Math.min(...boxes.map((b) => b[0])),
          Math.min(...boxes.map((b) => b[1])),
          Math.max(...boxes.map((b) => b[2])),
          Math.max(...boxes.map((b) => b[3])),
        ]);
      }
    }

    return infos[0];
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
      beforeId: record.info.beforeId,
    });
    this._attachPicker(record);
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
      mode: record.info.ingestMode,
    });
    record.tableName = summary.tableName;
    // The engine falls back to a table for formats streaming
    // does not apply to.
    record.info.ingestMode = summary.streamed ? 'stream' : 'table';
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
      beforeId: record.info.beforeId,
    });
    this._attachPicker(record);
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
      beforeId: record.info.beforeId,
    });
    this._attachPicker(record);
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
   * (GeoJSON objects and data: URLs become Blobs - DuckDB/GDAL cannot
   * fetch data: URLs).
   */
  private async _engineSource(source: VectorDataSource): Promise<string | File | Blob> {
    if (typeof source === 'string') {
      if (source.startsWith('data:')) {
        return (await fetch(source)).blob();
      }
      return source;
    }
    if (typeof Blob !== 'undefined' && source instanceof Blob) return source;
    return new Blob([JSON.stringify(source)], { type: 'application/geo+json' });
  }

  /**
   * Picks a registration file name for sources without one, using an
   * extension matching the format so readers can sniff the type.
   */
  private _defaultFileName(record: LayerRecord): string {
    const extensions: Record<string, string> = {
      geojson: 'geojson',
      geoparquet: 'parquet',
      geopackage: 'gpkg',
      shapefile: 'zip',
      flatgeobuf: 'fgb',
      csv: 'csv',
    };
    const format = record.info.format;
    const ext = extensions[format] ?? (format !== 'unknown' ? format : 'bin');
    return `${tableNameFor(record.info.id)}.${ext}`;
  }

  /**
   * Attaches click-to-inspect handlers to a layer's map layers,
   * opening a popup with the clicked feature's attributes.
   */
  private _attachPicker(record: LayerRecord): void {
    if (!record.info.picker) return;
    record.pickerHandlers = record.info.layerIds.map((layerId) => {
      const click = (e: MapLayerMouseEvent) => {
        const feature = e.features?.[0];
        if (feature) {
          void this._showPopup(record.info, e.lngLat, feature.properties ?? {});
        }
      };
      const enter = () => {
        this._map.getCanvas().style.cursor = 'pointer';
      };
      const leave = () => {
        this._map.getCanvas().style.cursor = '';
      };
      this._map.on('click', layerId, click);
      this._map.on('mouseenter', layerId, enter);
      this._map.on('mouseleave', layerId, leave);
      return { layerId, click, enter, leave };
    });
  }

  /**
   * Removes the picker handlers of a layer.
   */
  private _detachPicker(record: LayerRecord): void {
    for (const handler of record.pickerHandlers ?? []) {
      this._map.off('click', handler.layerId, handler.click);
      this._map.off('mouseenter', handler.layerId, handler.enter);
      this._map.off('mouseleave', handler.layerId, handler.leave);
    }
    record.pickerHandlers = undefined;
    // Close a popup owned by this layer so stale attributes do not
    // linger after removal or a render-mode switch.
    if (this._popupOwnerId === record.info.id) {
      this._popup?.remove();
      this._popup = undefined;
      this._popupOwnerId = undefined;
    }
  }

  /**
   * Opens (or replaces) the attribute popup for a clicked feature.
   * Content is built with textContent, so attribute values are inert.
   */
  private async _showPopup(
    info: Pick<VectorLayerInfo, 'id' | 'name'>,
    lngLat: { lng: number; lat: number },
    properties: Record<string, unknown>,
  ): Promise<void> {
    const container = document.createElement('div');
    container.className = 'vector-control-popup';

    const title = document.createElement('div');
    title.className = 'vector-control-popup-title';
    title.textContent = info.name;
    container.appendChild(title);

    const entries = Object.entries(properties);
    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'vector-control-popup-empty';
      empty.textContent = 'No attributes';
      container.appendChild(empty);
    } else {
      const table = document.createElement('table');
      table.className = 'vector-control-popup-table';
      for (const [key, value] of entries) {
        const row = table.insertRow();
        const keyCell = row.insertCell();
        keyCell.className = 'vector-control-popup-key';
        keyCell.textContent = key;
        const valueCell = row.insertCell();
        valueCell.textContent = value === null || value === undefined ? '' : String(value);
      }
      container.appendChild(table);
    }

    const maplibre = await getMaplibre();
    this._popup?.remove();
    const popup = new maplibre.Popup({ closeButton: true, maxWidth: '280px' });
    popup.setLngLat([lngLat.lng, lngLat.lat]);
    popup.setDOMContent(container);
    popup.addTo(this._map);
    this._popup = popup;
    this._popupOwnerId = info.id;
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
