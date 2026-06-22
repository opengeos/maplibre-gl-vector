import type {
  FilterSpecification,
  Map as MapLibreMap,
  SourceSpecification,
} from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import type { GeometryCategory, VectorLayerStyle } from '../core/types';
import type { Bbox } from '../utils/geometry';
import { buildLabelLayout, buildPaint, hasLabels, mapLayerId, pointModeOf } from './styleBuilder';

/** Map layer roles created by the geometry-type loop (excludes heatmap/cluster). */
type GeometrySuffix = 'fill' | 'outline' | 'line' | 'circle';

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
export function suffixesForGeometry(category: GeometryCategory): GeometrySuffix[] {
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

const SUFFIX_TYPES: Record<GeometrySuffix, 'fill' | 'line' | 'circle'> = {
  fill: 'fill',
  outline: 'line',
  line: 'line',
  circle: 'circle',
};

const SUFFIX_FILTERS: Record<GeometrySuffix, FilterSpecification> = {
  fill: ['==', ['geometry-type'], 'Polygon'],
  outline: ['==', ['geometry-type'], 'Polygon'],
  line: ['==', ['geometry-type'], 'LineString'],
  circle: ['==', ['geometry-type'], 'Point'],
};

const POINT_FILTER: FilterSpecification = ['==', ['geometry-type'], 'Point'];
const CLUSTER_FILTER: FilterSpecification = ['has', 'point_count'];
const UNCLUSTERED_FILTER: FilterSpecification = ['!', ['has', 'point_count']];

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
  cluster?: { radius: number; maxZoom: number },
): string {
  const sourceId = sourceIdFor(layerId);
  const spec: SourceSpecification = { type: 'geojson', data };
  if (attribution) spec.attribution = attribution;
  if (cluster) {
    spec.cluster = true;
    spec.clusterRadius = cluster.radius;
    spec.clusterMaxZoom = cluster.maxZoom;
  }
  map.addSource(sourceId, spec);
  return sourceId;
}

/**
 * Cluster options for a GeoJSON source when a point layer's style requests
 * clustering, or undefined otherwise (the source stays unclustered). Only
 * applies to geojson-rendered point layers.
 *
 * @param geometryType - The layer's geometry category
 * @param style - The layer style
 * @param sourceLayer - Set for vector-tile sources (clustering is geojson-only)
 * @returns Cluster options, or undefined
 */
export function clusterOptionsFor(
  geometryType: GeometryCategory,
  style: VectorLayerStyle,
  sourceLayer?: string,
): { radius: number; maxZoom: number } | undefined {
  if (sourceLayer || geometryType !== 'point') return undefined;
  if (pointModeOf(style) !== 'cluster') return undefined;
  return { radius: style.clusterRadius ?? 50, maxZoom: style.clusterMaxZoom ?? 14 };
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
  const layout = { visibility: visible ? 'visible' : 'none' };

  // Only honor beforeId when the target layer exists; addLayer throws
  // otherwise (e.g. a label layer absent from the active style).
  const before = beforeId && map.getLayer(beforeId) ? beforeId : undefined;

  const add = (id: string, spec: Record<string, unknown>): string => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    map.addLayer({ id, source: sourceId, layout, ...spec } as any, before);
    return id;
  };

  // Geojson point layers honor the style's pointMode (heatmap/cluster). Tiles
  // (sourceLayer set) and other geometries always use the standard roles.
  const pointMode = !sourceLayer && geometryType === 'point' ? pointModeOf(style) : 'circle';

  // An attribute label layer is appended last so it draws on top of the
  // geometry. Added for every geometry type and render mode; the symbol layer
  // references the same source (and source-layer for tiles).
  const withLabel = (ids: string[]): string[] => {
    if (hasLabels(style)) {
      ids.push(addLabelLayer(map, { layerId, style, visible, opacity, sourceLayer, beforeId }));
    }
    return ids;
  };

  if (pointMode === 'heatmap') {
    return withLabel([
      add(mapLayerId(layerId, 'heatmap'), {
        type: 'heatmap',
        filter: POINT_FILTER,
        paint: buildPaint('heatmap', style, opacity),
      }),
    ]);
  }

  if (pointMode === 'cluster') {
    return withLabel([
      add(mapLayerId(layerId, 'cluster'), {
        type: 'circle',
        filter: CLUSTER_FILTER,
        paint: buildPaint('cluster', style, opacity),
      }),
      add(mapLayerId(layerId, 'cluster-count'), {
        type: 'symbol',
        filter: CLUSTER_FILTER,
        layout: {
          ...layout,
          'text-field': ['get', 'point_count_abbreviated'],
          'text-size': 12,
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: buildPaint('cluster-count', style, opacity),
      }),
      add(mapLayerId(layerId, 'circle'), {
        type: 'circle',
        filter: UNCLUSTERED_FILTER,
        paint: buildPaint('circle', style, opacity),
      }),
    ]);
  }

  return withLabel(
    suffixesForGeometry(geometryType).map((suffix) =>
      add(mapLayerId(layerId, suffix), {
        type: SUFFIX_TYPES[suffix],
        ...(sourceLayer ? { 'source-layer': sourceLayer } : {}),
        filter: SUFFIX_FILTERS[suffix],
        paint: buildPaint(suffix, style, opacity),
      }),
    ),
  );
}

/**
 * Options for adding the attribute label layer of a vector layer.
 */
export interface AddLabelLayerOptions {
  /** The vector layer id */
  layerId: string;
  /** Layer style (its label* fields drive the symbol layer) */
  style: VectorLayerStyle;
  /** Whether the layer starts visible */
  visible: boolean;
  /** Master opacity (0-1) multiplied into the text opacity */
  opacity?: number;
  /** source-layer name for vector tile sources (omit for geojson) */
  sourceLayer?: string;
  /** Existing map layer id to insert the label layer before */
  beforeId?: string;
}

/**
 * Adds the attribute label `symbol` layer for a vector layer, rendering the
 * style's `labelField` value as text for every feature.
 *
 * @param map - The MapLibre map
 * @param options - Label layer creation options
 * @returns The created label map layer id
 */
export function addLabelLayer(map: MapLibreMap, options: AddLabelLayerOptions): string {
  const { layerId, style, visible, opacity, sourceLayer, beforeId } = options;
  const id = mapLayerId(layerId, 'label');
  const before = beforeId && map.getLayer(beforeId) ? beforeId : undefined;
  map.addLayer(
    {
      id,
      type: 'symbol',
      source: sourceIdFor(layerId),
      ...(sourceLayer ? { 'source-layer': sourceLayer } : {}),
      layout: buildLabelLayout(style, visible),
      paint: buildPaint('label', style, opacity),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    before,
  );
  return id;
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
