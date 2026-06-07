import type {
  FilterSpecification,
  Map as MapLibreMap,
  SourceSpecification,
} from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import type { GeometryCategory, VectorLayerStyle } from '../core/types';
import type { Bbox } from '../utils/geometry';
import { buildPaint, mapLayerId, type LayerSuffix } from './styleBuilder';

/**
 * Builds the map source id for a vector layer.
 *
 * @param layerId - The vector layer id
 * @returns The map source id
 */
export function sourceIdFor(layerId: string): string {
  return `${layerId}-source`;
}

/**
 * Returns the map layer roles needed for a geometry category.
 *
 * Mixed or unknown geometry gets all roles with geometry-type filters so
 * each feature renders with the appropriate layer.
 *
 * @param category - The geometry category
 * @returns The layer suffixes to create
 */
export function suffixesForGeometry(category: GeometryCategory): LayerSuffix[] {
  switch (category) {
    case 'polygon':
      return ['fill', 'outline'];
    case 'line':
      return ['line'];
    case 'point':
      return ['circle'];
    default:
      return ['fill', 'outline', 'line', 'circle'];
  }
}

const SUFFIX_TYPES: Record<LayerSuffix, 'fill' | 'line' | 'circle'> = {
  fill: 'fill',
  outline: 'line',
  line: 'line',
  circle: 'circle',
};

const SUFFIX_FILTERS: Record<LayerSuffix, FilterSpecification> = {
  fill: ['==', ['geometry-type'], 'Polygon'],
  outline: ['==', ['geometry-type'], 'Polygon'],
  line: ['==', ['geometry-type'], 'LineString'],
  circle: ['==', ['geometry-type'], 'Point'],
};

/**
 * Options for adding the map layers of a vector layer.
 */
export interface AddLayersOptions {
  /** The vector layer id */
  layerId: string;
  /** Geometry category determining which map layers are created */
  geometryType: GeometryCategory;
  /** Layer style */
  style: VectorLayerStyle;
  /** Whether the layer starts visible */
  visible: boolean;
  /** Master opacity (0-1) multiplied into every style opacity */
  opacity?: number;
  /** source-layer name for vector tile sources (omit for geojson) */
  sourceLayer?: string;
  /** Existing map layer id to insert the new layers before */
  beforeId?: string;
}

/**
 * Adds a GeoJSON source to the map.
 *
 * @param map - The MapLibre map
 * @param layerId - The vector layer id
 * @param data - The FeatureCollection to render
 * @param attribution - Optional attribution string
 * @returns The created source id
 */
export function addGeoJSONSource(
  map: MapLibreMap,
  layerId: string,
  data: FeatureCollection,
  attribution?: string,
): string {
  const sourceId = sourceIdFor(layerId);
  const spec: SourceSpecification = { type: 'geojson', data };
  if (attribution) spec.attribution = attribution;
  map.addSource(sourceId, spec);
  return sourceId;
}

/**
 * Options for adding a dynamic vector tile source.
 */
export interface AddVectorSourceOptions {
  /** Tile URL template (e.g. duckdb://layer/{z}/{x}/{y}) */
  tileUrl: string;
  /** Maximum zoom at which tiles are generated */
  maxzoom: number;
  /** Layer extent used to skip out-of-bounds tile requests */
  bounds?: Bbox;
  /** Optional attribution string */
  attribution?: string;
}

/**
 * Adds a vector tile source backed by the duckdb:// protocol.
 *
 * @param map - The MapLibre map
 * @param layerId - The vector layer id
 * @param options - Source options
 * @returns The created source id
 */
export function addVectorTileSource(
  map: MapLibreMap,
  layerId: string,
  options: AddVectorSourceOptions,
): string {
  const sourceId = sourceIdFor(layerId);
  const spec: SourceSpecification = {
    type: 'vector',
    tiles: [options.tileUrl],
    minzoom: 0,
    maxzoom: options.maxzoom,
  };
  if (options.bounds) spec.bounds = options.bounds;
  if (options.attribution) spec.attribution = options.attribution;
  map.addSource(sourceId, spec);
  return sourceId;
}

/**
 * Adds the styled map layers for a vector layer source.
 *
 * @param map - The MapLibre map
 * @param options - Layer creation options
 * @returns The created map layer ids
 */
export function addGeometryLayers(map: MapLibreMap, options: AddLayersOptions): string[] {
  const { layerId, geometryType, style, visible, opacity, sourceLayer, beforeId } = options;
  const sourceId = sourceIdFor(layerId);
  const suffixes = suffixesForGeometry(geometryType);
  const layerIds: string[] = [];

  // Only honor beforeId when the target layer exists; addLayer throws
  // otherwise (e.g. a label layer absent from the active style).
  const before = beforeId && map.getLayer(beforeId) ? beforeId : undefined;

  for (const suffix of suffixes) {
    const id = mapLayerId(layerId, suffix);
    map.addLayer(
      {
        id,
        type: SUFFIX_TYPES[suffix],
        source: sourceId,
        ...(sourceLayer ? { 'source-layer': sourceLayer } : {}),
        filter: SUFFIX_FILTERS[suffix],
        paint: buildPaint(suffix, style, opacity),
        layout: { visibility: visible ? 'visible' : 'none' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      before,
    );
    layerIds.push(id);
  }

  return layerIds;
}

/**
 * Sets the visibility of all map layers of a vector layer.
 *
 * @param map - The MapLibre map
 * @param layerIds - The map layer ids
 * @param visible - Whether the layers should be visible
 */
export function setLayersVisibility(
  map: MapLibreMap,
  layerIds: string[],
  visible: boolean,
): void {
  for (const id of layerIds) {
    map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }
}

/**
 * Removes the map layers and source of a vector layer.
 *
 * @param map - The MapLibre map
 * @param layerIds - The map layer ids to remove
 * @param sourceId - The source id to remove
 */
export function removeLayersAndSource(
  map: MapLibreMap,
  layerIds: string[],
  sourceId: string,
): void {
  for (const id of layerIds) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource(sourceId)) map.removeSource(sourceId);
}
