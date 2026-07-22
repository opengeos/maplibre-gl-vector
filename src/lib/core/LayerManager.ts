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
  VectorLayerSelector,
} from './types';
import { VectorLayerSelectionCancelledError } from './errors';
import { openLayerPicker, type LayerPickerHandle } from '../ui/layerPicker';
import type { EngineProvider } from '../engine/types';
import type { VectorSourceDescriptor } from './types';
import { detectSource } from '../formats/detect';
import { sniffRemoteGeoJSON } from '../formats/geojsonSniff';
import { decideRenderMode } from '../render/renderMode';
import {
  DEFAULT_LABEL_SIZE,
  DEFAULT_STYLE,
  applyOpacity,
  applyStyle,
  clampOpacity,
  hasLabels,
  labelTextField,
  mapLayerId,
  pointModeOf,
} from '../render/styleBuilder';
import {
  addGeoJSONSource,
  addGeometryLayers,
  addLabelLayer,
  addVectorTileSource,
  clusterOptionsFor,
  removeLayersAndSource,
  setLayersVisibility,
  sourceIdFor,
} from '../render/mapSources';
import { registerTileProvider, tileUrlFor, unregisterTileProvider } from '../tiles/protocol';
import {
  collectFieldNames,
  crsFromGeoJSON,
  summarizeFeatureCollection,
  toFeatureCollection,
} from '../utils/geometry';
import { generateId } from '../utils/helpers';
import { getMaplibre } from '../utils/maplibre';
import { assertRemoteFileSupported } from '../utils/remote';

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
  /** Sidecar files for a loose shapefile, registered alongside its `.shp`. */
  companionFiles?: File[];
  /**
   * The FeatureCollection backing a geojson-rendered layer, cached so a
   * structural restyle (pointMode/cluster change) can rebuild the source and
   * layers without re-fetching or reading it back from the map.
   */
  geojson?: FeatureCollection;
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
 * Describes where a data source came from, so hosts can persist and
 * later recreate URL-backed layers (files and objects cannot be
 * recreated from the descriptor).
 *
 * @param source - The data source passed to addData
 * @param sourcePath - Host-meaningful path a File/Blob was read from, echoed
 *   on the descriptor so the host can re-read it on project restore. Ignored
 *   for URL and GeoJSON-object sources.
 * @returns The public source descriptor
 */
export function describeSource(
  source: VectorDataSource,
  sourcePath?: string,
): VectorSourceDescriptor {
  if (typeof source === 'string') {
    return { kind: 'url', url: source };
  }
  const path = sourcePath?.trim() ? sourcePath : undefined;
  if (typeof File !== 'undefined' && source instanceof File) {
    return { kind: 'file', fileName: source.name, ...(path ? { path } : {}) };
  }
  if (typeof Blob !== 'undefined' && source instanceof Blob) {
    return { kind: 'file', ...(path ? { path } : {}) };
  }
  return { kind: 'geojson' };
}

/**
 * Detects a loose `.shp` file that cannot be read because its required
 * `.shx`/`.dbf` siblings were not provided.
 *
 * A shapefile is a set of files. A lone `.shp` (or one missing the index or
 * attribute sidecar) makes GDAL fail with an opaque "GDALOpen() called on
 * x.shp recursively" error; callers use this to surface an actionable message
 * instead. A zipped shapefile (`.zip`) carries its components, so it is never
 * flagged.
 *
 * @param source - The data source passed to addData.
 * @param options - The layer options, whose `companionFiles` hold the sidecars.
 * @returns True when the source is a `.shp` lacking its `.shx` or `.dbf`.
 */
export function isLooseShapefileMissingSiblings(
  source: VectorDataSource,
  options: VectorLayerOptions,
): boolean {
  if (typeof File === 'undefined' || !(source instanceof File)) return false;
  if (!/\.shp$/i.test(source.name)) return false;
  const extensions = new Set(
    (options.companionFiles ?? []).map((file) =>
      file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase(),
    ),
  );
  return !extensions.has('shx') || !extensions.has('dbf');
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
  private _pendingTiles = 0;
  private _tileStatusTimer?: ReturnType<typeof setTimeout>;
  // Multi-layer pickers currently on screen (or queued), so dispose() can
  // close them instead of orphaning a modal in the map container.
  private _openPickers = new Set<LayerPickerHandle>();

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
   * Materializes a layer's features as a GeoJSON FeatureCollection, so a host
   * can persist the data of a layer loaded from a local file (which a saved
   * project cannot otherwise recreate). The data comes from the cached
   * collection (point geojson layers), the DuckDB table (engine/tiles layers),
   * or the layer's map source (line/polygon geojson layers). Returns null for
   * an unknown id, or a layer whose data is not held locally (e.g. a GeoParquet
   * streamed in place, which is queried from its source per tile).
   *
   * @param id - The layer id.
   * @returns The features as a FeatureCollection, or null when unavailable.
   */
  async getLayerGeoJSON(id: string): Promise<FeatureCollection | null> {
    const record = this._records.get(id);
    if (!record) return null;
    if (record.geojson) return record.geojson;
    if (record.tableName) {
      const engine = await this._getEngine();
      return engine.exportGeoJSON(record.tableName);
    }
    // A line/polygon geojson layer keeps no cached copy (to avoid pinning the
    // heap), but its data lives in the map source it was added with.
    const source = this._map.getSource(record.info.sourceId);
    const serialized = source?.serialize() as { data?: unknown } | undefined;
    const data = serialized?.data;
    if (data && typeof data === 'object' && (data as FeatureCollection).type) {
      return data as FeatureCollection;
    }
    return null;
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

    // A shapefile is several files. A lone `.shp` (or one missing its `.shx`/
    // `.dbf` siblings) cannot be read, and GDAL fails with an opaque
    // "GDALOpen() called on x.shp recursively" error. Surface an actionable
    // message instead, before any engine work, telling the user to select the
    // companion files too (or load the shapefile as a single `.zip`).
    if (detected.format === 'shapefile' && isLooseShapefileMissingSiblings(source, options)) {
      const error = new Error(
        'A shapefile is a set of files. Select the .shp together with its ' +
          '.shx and .dbf files (and .prj, .cpg if present), or load the ' +
          'shapefile as a single .zip archive.',
      );
      this._emit('error', { error });
      throw error;
    }

    // Extensionless remote URLs (OGC API Features / ArcGIS `f=geojson`, custom
    // service endpoints with query strings) return GeoJSON the file-name
    // detector classifies as 'unknown', which would route to the DuckDB engine
    // and its remote spatial-extension install -- a hang in sandboxed/offline
    // environments. Sniff the response first so a GeoJSON endpoint stays on the
    // pure-JS path; the fetched data is reused so it is not re-downloaded.
    let prefetchedGeoJSON: { collection: FeatureCollection; byteSize?: number } | undefined;
    if (
      detected.format === 'unknown' &&
      !options.format &&
      options.renderMode !== 'tiles' &&
      typeof source === 'string' &&
      !source.startsWith('data:')
    ) {
      const sniffed = await sniffRemoteGeoJSON(source);
      if (sniffed) {
        detected.format = 'geojson';
        prefetchedGeoJSON = sniffed;
      }
    }

    // Reject remote files DuckDB-WASM cannot open BEFORE the engine
    // download starts, so the error is immediate.
    const engineBound = !(detected.format === 'geojson' && options.renderMode !== 'tiles');
    if (engineBound && typeof source === 'string') {
      try {
        await assertRemoteFileSupported(source);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this._emit('error', { error });
        throw error;
      }
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
        source: describeSource(source, options.sourcePath),
        format: detected.format,
        renderMode: 'geojson',
        geometryType: 'unknown',
        visible,
        opacity: clampOpacity(options.opacity ?? 1),
        picker: options.picker ?? this._options.enablePicker ?? true,
        ingestMode: options.ingestMode ?? this._options.defaultIngestMode ?? 'table',
        sourceLayer: options.sourceLayer,
        beforeId: options.beforeId ?? this._options.beforeId,
        style,
        sourceId: sourceIdFor(id),
        layerIds: [],
      },
      source,
      sourceLayer: options.sourceLayer,
      fileName: typeof File !== 'undefined' && source instanceof File ? source.name : undefined,
      companionFiles: options.companionFiles,
    };

    this._emit('loading', { message: `Loading ${name}...` });

    try {
      if (detected.format === 'geojson' && options.renderMode !== 'tiles') {
        await this._addGeoJSON(record, options, prefetchedGeoJSON);
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
    const prev = record.info.style;
    const next = { ...prev, ...patch };
    record.info.style = next;
    // pointMode (and cluster radius/maxZoom) are structural: they change the
    // layer types and/or the source's clustering, which setPaintProperty cannot
    // express, so rebuild the layers instead of patching paint. The rebuild
    // re-adds the label layer from the current style, so no separate label
    // handling is needed on that branch.
    if (this._isStructuralPointChange(record, prev, next)) {
      this._rebuildPointLayers(record);
    } else if (this._isExtrusionToggle(record, prev, next)) {
      // Flipping extrusion on or off swaps a polygon layer between flat fill and
      // a fill-extrusion layer, which setPaintProperty cannot express; rebuild
      // the map layers (the source is unchanged). The rebuild re-adds the label
      // layer from the current style, so no separate label handling is needed.
      this._rebuildGeometryLayers(record);
    } else {
      applyStyle(this._map, record.info, patch, record.info.opacity);
      this._applyLabelChange(record, prev, next, patch);
    }
    this._emit('layerupdated', { layer: { ...record.info } });
  }

  /**
   * Reconciles the attribute label layer after a style patch: adds it when a
   * labelField is newly set, removes it when cleared, and otherwise applies
   * the label layout changes (text-field, size, placement, overlap) that
   * `applyStyle` (which only touches paint) cannot.
   */
  private _applyLabelChange(
    record: LayerRecord,
    prev: VectorLayerStyle,
    next: VectorLayerStyle,
    patch: Partial<VectorLayerStyle>,
  ): void {
    const had = hasLabels(prev);
    const has = hasLabels(next);
    const labelId = mapLayerId(record.info.id, 'label');

    if (has && (!had || !this._map.getLayer(labelId))) {
      this._addLabelLayer(record);
      // The label layer joined layerIds, so re-wire the picker to cover it
      // (picker handlers are attached per layer id; see _attachPicker).
      this._refreshPicker(record);
      return;
    }
    if (!has) {
      if (had && this._map.getLayer(labelId)) {
        this._map.removeLayer(labelId);
        record.info.layerIds = record.info.layerIds.filter((id) => id !== labelId);
        // Drop the now-stale picker handler for the removed label layer.
        this._refreshPicker(record);
      }
      return;
    }

    // Both before and after have labels: apply the layout-side changes (paint
    // changes already went through applyStyle).
    if (patch.labelField !== undefined) {
      this._map.setLayoutProperty(labelId, 'text-field', labelTextField(next));
    }
    if (patch.labelSize !== undefined) {
      this._map.setLayoutProperty(labelId, 'text-size', next.labelSize ?? DEFAULT_LABEL_SIZE);
    }
    if (patch.labelPlacement !== undefined) {
      this._map.setLayoutProperty(
        labelId,
        'symbol-placement',
        next.labelPlacement === 'line' ? 'line' : 'point',
      );
    }
    if (patch.labelAllowOverlap !== undefined) {
      const allow = next.labelAllowOverlap ?? false;
      this._map.setLayoutProperty(labelId, 'text-allow-overlap', allow);
      this._map.setLayoutProperty(labelId, 'text-ignore-placement', allow);
    }
  }

  /**
   * Adds the attribute label layer for a record and records its id, choosing
   * the source-layer for tile-rendered layers.
   */
  private _addLabelLayer(record: LayerRecord): void {
    const labelId = mapLayerId(record.info.id, 'label');
    if (this._map.getLayer(labelId)) return;
    addLabelLayer(this._map, {
      layerId: record.info.id,
      style: record.info.style,
      visible: record.info.visible,
      opacity: record.info.opacity,
      sourceLayer: record.info.renderMode === 'tiles' ? record.info.id : undefined,
      beforeId: record.info.beforeId,
    });
    if (!record.info.layerIds.includes(labelId)) record.info.layerIds.push(labelId);
  }

  /**
   * Re-attaches the picker so its handlers cover the current `layerIds` after a
   * label layer is added or removed at runtime. A no-op when the picker is off.
   */
  private _refreshPicker(record: LayerRecord): void {
    if (!record.info.picker) return;
    this._detachPicker(record);
    this._attachPicker(record);
  }

  /**
   * Whether a style change requires rebuilding a geojson point layer's map
   * layers (a pointMode switch, or a cluster radius/maxZoom change while
   * clustered) rather than a plain paint update.
   */
  private _isStructuralPointChange(
    record: LayerRecord,
    prev: VectorLayerStyle,
    next: VectorLayerStyle,
  ): boolean {
    if (record.info.renderMode !== 'geojson' || record.info.geometryType !== 'point') {
      return false;
    }
    if (pointModeOf(prev) !== pointModeOf(next)) return true;
    return (
      pointModeOf(next) === 'cluster' &&
      ((prev.clusterRadius ?? 50) !== (next.clusterRadius ?? 50) ||
        (prev.clusterMaxZoom ?? 14) !== (next.clusterMaxZoom ?? 14))
    );
  }

  /**
   * Whether a style change toggles 3D extrusion on a layer with polygon
   * geometry, which swaps the flat `fill`/`outline` layers for a single
   * `fill-extrusion` layer (and back). Such a change is structural — the map
   * layer types differ — so it cannot be a plain paint update. Restyle edits
   * made while extrusion stays on (color/height/base/opacity) are paint ops.
   */
  private _isExtrusionToggle(
    record: LayerRecord,
    prev: VectorLayerStyle,
    next: VectorLayerStyle,
  ): boolean {
    const geometry = record.info.geometryType;
    if (geometry !== 'polygon' && geometry !== 'mixed' && geometry !== 'unknown') {
      return false;
    }
    return (prev.extrusionEnabled === true) !== (next.extrusionEnabled === true);
  }

  /**
   * Rebuilds a layer's map layers from the existing source, so an extrusion
   * toggle re-creates the polygon layers (flat fill vs fill-extrusion) without
   * re-fetching or re-adding the source. Preserves the picker.
   */
  private _rebuildGeometryLayers(record: LayerRecord): void {
    this._detachPicker(record);
    for (const id of record.info.layerIds) {
      if (this._map.getLayer(id)) this._map.removeLayer(id);
    }
    record.info.layerIds = addGeometryLayers(this._map, {
      layerId: record.info.id,
      geometryType: record.info.geometryType,
      style: record.info.style,
      visible: record.info.visible,
      opacity: record.info.opacity,
      sourceLayer: record.info.renderMode === 'tiles' ? record.info.id : undefined,
      beforeId: record.info.beforeId,
    });
    this._attachPicker(record);
  }

  /**
   * Rebuilds a geojson point layer's source and map layers from the data
   * already held by the source, so a pointMode/cluster change takes effect
   * without re-fetching. Preserves the picker.
   */
  private _rebuildPointLayers(record: LayerRecord): void {
    // Use the cached FeatureCollection: reading it back from the map via
    // source.serialize() is unreliable for a clustered source.
    const collection = record.geojson;
    if (!collection) return;
    const sourceId = record.info.sourceId;
    this._detachPicker(record);
    removeLayersAndSource(this._map, record.info.layerIds, sourceId);
    addGeoJSONSource(
      this._map,
      record.info.id,
      collection,
      this._options.attribution,
      clusterOptionsFor(record.info.geometryType, record.info.style),
    );
    record.info.layerIds = addGeometryLayers(this._map, {
      layerId: record.info.id,
      geometryType: record.info.geometryType,
      style: record.info.style,
      visible: record.info.visible,
      opacity: record.info.opacity,
      beforeId: record.info.beforeId,
    });
    this._attachPicker(record);
  }

  /**
   * Sets a layer's master opacity, multiplied into every style opacity
   * (fill, circle, and line layers alike).
   *
   * @param id - The layer id
   * @param opacity - The new opacity (0-1)
   */
  setLayerOpacity(id: string, opacity: number): void {
    const record = this._records.get(id);
    if (!record) return;
    const clamped = clampOpacity(opacity);
    if (record.info.opacity === clamped) return;
    record.info.opacity = clamped;
    applyOpacity(this._map, record.info, record.info.style, clamped);
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
   * Re-fetches a URL-backed layer's data and re-renders it in place,
   * preserving the layer id, source id, style, render mode, and stacking
   * position. File and in-memory GeoJSON sources are static between loads,
   * so for those the current info is returned unchanged.
   *
   * @param id - The layer id
   * @returns The refreshed layer info, or undefined when no such layer exists
   */
  async reloadLayer(id: string): Promise<VectorLayerInfo | undefined> {
    const record = this._records.get(id);
    if (!record) return undefined;
    // Only URL sources can change between loads; files/objects are static.
    if (typeof record.source !== 'string') return { ...record.info };

    this._emit('loading', { message: `Refreshing ${record.info.name}...` });

    try {
      // Tear down the current presentation (mirrors setRenderMode).
      this._detachPicker(record);
      removeLayersAndSource(this._map, record.info.layerIds, record.info.sourceId);
      if (record.providerKey) {
        unregisterTileProvider(record.providerKey);
        record.providerKey = undefined;
      }
      record.info.layerIds = [];

      // Drop the stale engine table so the next ingest re-reads the source.
      if (record.tableName) {
        const tableName = record.tableName;
        record.tableName = undefined;
        const engine = await this._getEngine();
        await engine.dropTable(tableName).catch(() => {
          // Table already gone; nothing to clean up.
        });
      }

      // Re-run the load pipeline, preserving the resolved render mode so a
      // refresh does not flip a tiles layer to geojson (or vice versa).
      const reloadOptions: VectorLayerOptions = {
        renderMode: record.info.renderMode,
        ingestMode: record.info.ingestMode,
        sourceLayer: record.sourceLayer,
      };
      if (record.info.format === 'geojson' && record.info.renderMode !== 'tiles') {
        await this._addGeoJSON(record, reloadOptions);
      } else {
        await this._addViaEngine(record, reloadOptions);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this._emit('error', { error });
      throw error;
    }

    this._emit('layerupdated', { layer: { ...record.info } });
    return { ...record.info };
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
    // A picker still on screen belongs to the map container, which outlives
    // the control; close it so no modal is left over the map.
    for (const picker of this._openPickers) picker.close();
    this._openPickers.clear();
    this._popup?.remove();
    this._popup = undefined;
    if (this._tileStatusTimer) {
      clearTimeout(this._tileStatusTimer);
      this._tileStatusTimer = undefined;
    }
  }

  /**
   * Expands a multi-layer container into one vector layer per selected
   * source layer, when the source is engine-readable, no sourceLayer was
   * requested, and the container reports more than one layer.
   *
   * Which layers those are comes from {@link VectorLayerOptions.sourceLayers}
   * when the caller named them, otherwise from the layer selector (the
   * built-in picker unless the host replaced or disabled it), otherwise all
   * of them.
   *
   * @returns The first created layer's info, or null when the source
   *   is single-layer (callers continue with the normal flow)
   * @throws VectorLayerSelectionCancelledError when the user dismissed the
   *   picker without choosing a layer.
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
      // A loose shapefile must register its sidecars on this first probe too:
      // the engine caches the registration by source, so a companion-less
      // probe would leave the cached `.shp` unreadable for the later ingest.
      companionFiles: options.companionFiles,
    });
    if (layerNames.length <= 1) return null;

    const sourceName = options.name ?? detected.name;
    const selected = await this._selectContainerLayers(layerNames, options, detected, sourceName);

    this._emit('loading', {
      message:
        selected.length === 1
          ? `Loading 1 layer from ${sourceName}...`
          : `Loading ${selected.length} layers from ${sourceName}...`,
    });

    const infos: VectorLayerInfo[] = [];
    // The container-level selection is already resolved, so it is dropped from
    // the per-layer options; each sub-load names its single `sourceLayer`.
    const layerOptions: VectorLayerOptions = { ...options };
    delete layerOptions.sourceLayers;
    for (const layerName of selected) {
      const subId = `${id}-${layerName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      infos.push(
        await this.addData(source, {
          ...layerOptions,
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
   * Resolves which layers of a multi-layer container to load.
   *
   * An explicit `sourceLayers` list wins; otherwise the layer selector runs
   * (the built-in modal picker unless the host replaced it, or `false`
   * disabled prompting); otherwise every layer is loaded. Whatever the source,
   * the result is intersected with the container's real layers and ordered by
   * the container, so a selector cannot invent a layer or reorder the load.
   *
   * @throws VectorLayerSelectionCancelledError when the selector returned an
   *   empty selection (the user dismissed the picker).
   */
  private async _selectContainerLayers(
    layerNames: string[],
    options: VectorLayerOptions,
    detected: { format: VectorLayerInfo['format'] },
    sourceName: string,
  ): Promise<string[]> {
    const inContainerOrder = (names: readonly string[]): string[] => {
      const wanted = new Set(names.map((name) => name.toLowerCase()));
      return layerNames.filter((name) => wanted.has(name.toLowerCase()));
    };

    if (options.sourceLayers) {
      const requested = inContainerOrder(options.sourceLayers);
      if (requested.length === 0) {
        throw new Error(
          `None of the requested layers (${options.sourceLayers.join(', ')}) exist in ` +
            `${sourceName}. Available layers: ${layerNames.join(', ')}.`,
        );
      }
      return requested;
    }

    const selector = this._layerSelector();
    if (!selector) return layerNames;

    const chosen = await selector(layerNames, { sourceName, format: detected.format });
    // null/undefined means "no opinion": keep the load-everything default so a
    // host selector that only handles some formats can defer on the rest.
    if (chosen == null) return layerNames;
    const selected = inContainerOrder(chosen);
    if (selected.length === 0) {
      throw new VectorLayerSelectionCancelledError(
        `No layers were selected from ${sourceName}.`,
      );
    }
    return selected;
  }

  /**
   * The layer selector in force: the host's when it supplied one, none when it
   * set `selectLayers: false` (load every layer), else the built-in modal
   * picker rendered over the map container.
   */
  private _layerSelector(): VectorLayerSelector | null {
    const configured = this._options.selectLayers;
    if (configured === false) return null;
    if (configured) return configured;
    return (layers, context) => {
      const container = this._map.getContainer?.();
      // No container to render into (a headless/mock map): fall back to
      // loading every layer rather than blocking on a modal nobody can see.
      if (!container) return null;
      const picker = openLayerPicker({ container, layers, sourceName: context.sourceName });
      this._openPickers.add(picker);
      return picker.selection.finally(() => this._openPickers.delete(picker));
    };
  }

  /**
   * Loads a GeoJSON source entirely in JavaScript (no DuckDB), falling
   * back to the engine when auto mode trips the size thresholds.
   *
   * @param prefetched - A collection already fetched by the URL GeoJSON
   *   sniff, reused so an extensionless GeoJSON endpoint is not requested
   *   twice.
   */
  private async _addGeoJSON(
    record: LayerRecord,
    options: VectorLayerOptions,
    prefetched?: { collection: FeatureCollection; byteSize?: number },
  ): Promise<void> {
    const resolved = prefetched ?? (await this._resolveGeoJSON(record.source));
    const { byteSize } = resolved;
    let collection = resolved.collection;
    const summary = summarizeFeatureCollection(collection);

    record.info.featureCount = summary.featureCount;
    record.info.byteSize = byteSize;
    record.info.bbox = summary.bbox;
    record.info.geometryType = summary.geometryType;
    record.info.fields = collectFieldNames(collection);

    const mode = decideRenderMode({
      requested: options.renderMode,
      defaultMode: this._options.defaultRenderMode,
      featureCount: summary.featureCount,
      byteSize,
      threshold: this._options.autoThreshold,
    });

    if (mode === 'tiles') {
      // The tile path re-reads the original source through the DuckDB engine,
      // which reprojects to WGS84 from the source metadata as part of ingest, so
      // a projected collection is handled there without the in-memory reproject
      // below (and its metres bbox above is replaced by the engine's).
      await this._presentTiles(record);
      return;
    }

    // A projected GeoJSON declares its CRS via a legacy `crs` member and carries
    // raw projected coordinates (metres) that MapLibre cannot render, so spin up
    // the DuckDB engine (only in this case, keeping the WGS84 fast path
    // engine-free) and reproject to EPSG:4326 before rendering. Without this the
    // raw coordinates trip MapLibre's "Invalid LngLat" guard in the fitBounds
    // that follows, and the panel is left stuck loading.
    const sourceCrs = crsFromGeoJSON(collection);
    if (sourceCrs) {
      this._emit('loading', { message: `Reprojecting ${record.info.name} to WGS84...` });
      const engine = await this._getEngine();
      collection = await engine.reprojectGeoJSON(collection, sourceCrs);
      const reprojectedSummary = summarizeFeatureCollection(collection);
      // Replace the projected-metres bbox with the WGS84 extent so the caller's
      // fitBounds receives valid lon/lat.
      record.info.bbox = reprojectedSummary.bbox;
    }

    record.info.renderMode = 'geojson';
    // Only point layers use the cached collection (for a pointMode rebuild), so
    // don't pin a full copy of polygon/line data in the JS heap.
    record.geojson = summary.geometryType === 'point' ? collection : undefined;
    addGeoJSONSource(
      this._map,
      record.info.id,
      collection,
      this._options.attribution,
      clusterOptionsFor(summary.geometryType, record.info.style),
    );
    record.info.layerIds = addGeometryLayers(this._map, {
      layerId: record.info.id,
      geometryType: summary.geometryType,
      style: record.info.style,
      visible: record.info.visible,
      opacity: record.info.opacity,
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
    this._emit('loading', {
      message:
        record.info.ingestMode === 'stream'
          ? `Opening ${record.info.name} (streaming, reading metadata)...`
          : `Reading ${record.info.name} into DuckDB...`,
    });
    const summary = await engine.ingest(source, tableName, {
      format: record.info.format,
      sourceLayer: record.sourceLayer,
      fileName: record.fileName ?? this._defaultFileName(record),
      mode: record.info.ingestMode,
      companionFiles: record.companionFiles,
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
    if (record.info.ingestMode !== 'stream') {
      this._emit('loading', {
        message: `Indexing ${record.info.name} for tiles (reprojecting + R-Tree)...`,
      });
    }
    await engine.prepareTiles(tableName);

    const id = record.info.id;
    // The provider registry is process-wide; key it by a generated
    // unique value so equal layer ids on two controls cannot collide.
    const providerKey = record.providerKey ?? generateId(`${id}-tiles`);
    record.providerKey = providerKey;
    await registerTileProvider(providerKey, (z, x, y, signal) =>
      this._trackTileActivity(engine.getTile(tableName, id, z, x, y, signal)),
    );

    record.info.renderMode = 'tiles';
    // Tiles never rebuild from a cached collection; drop any copy from a prior
    // geojson render so it isn't pinned in the heap.
    record.geojson = undefined;
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
      opacity: record.info.opacity,
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
      this._emit('loading', { message: `Converting ${record.info.name} to GeoJSON...` });
      collection = await engine.exportGeoJSON(record.tableName);
    } else {
      collection = (await this._resolveGeoJSON(record.source)).collection;
    }

    if (record.info.geometryType === 'unknown') {
      record.info.geometryType = summarizeFeatureCollection(collection).geometryType;
    }
    record.info.fields = collectFieldNames(collection);

    record.info.renderMode = 'geojson';
    // Only point layers use the cached collection (for a pointMode rebuild).
    record.geojson = record.info.geometryType === 'point' ? collection : undefined;
    addGeoJSONSource(
      this._map,
      record.info.id,
      collection,
      this._options.attribution,
      clusterOptionsFor(record.info.geometryType, record.info.style),
    );
    record.info.layerIds = addGeometryLayers(this._map, {
      layerId: record.info.id,
      geometryType: record.info.geometryType,
      style: record.info.style,
      visible: record.info.visible,
      opacity: record.info.opacity,
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

  /**
   * Surfaces tile generation progress through 'loading' events: shows
   * a pending count while tile queries run and clears the status
   * shortly after the queue drains (the delay avoids flicker between
   * consecutive tiles).
   */
  private _trackTileActivity(task: Promise<Uint8Array>): Promise<Uint8Array> {
    this._pendingTiles += 1;
    if (this._tileStatusTimer) {
      clearTimeout(this._tileStatusTimer);
      this._tileStatusTimer = undefined;
    }
    this._emit('loading', { message: `Generating tiles (${this._pendingTiles} pending)...` });

    const settle = () => {
      this._pendingTiles -= 1;
      if (this._pendingTiles === 0) {
        this._tileStatusTimer = setTimeout(() => {
          this._tileStatusTimer = undefined;
          this._emit('loading', { message: '' });
        }, 400);
      } else {
        this._emit('loading', { message: `Generating tiles (${this._pendingTiles} pending)...` });
      }
    };

    return task.then(
      (value) => {
        settle();
        return value;
      },
      (err) => {
        settle();
        throw err;
      },
    );
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
