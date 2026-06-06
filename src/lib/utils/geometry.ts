import type { Feature, FeatureCollection, GeoJSON, Geometry, Position } from 'geojson';
import type { GeometryCategory } from '../core/types';

/**
 * Bounding box as [minX, minY, maxX, maxY] in EPSG:4326.
 */
export type Bbox = [number, number, number, number];

/**
 * Classifies a GeoJSON geometry type into a broad category.
 *
 * @param type - GeoJSON geometry type string
 * @returns The geometry category
 */
export function classifyGeometryType(type: string): GeometryCategory {
  switch (type) {
    case 'Point':
    case 'MultiPoint':
      return 'point';
    case 'LineString':
    case 'MultiLineString':
      return 'line';
    case 'Polygon':
    case 'MultiPolygon':
      return 'polygon';
    case 'GeometryCollection':
      return 'mixed';
    default:
      return 'unknown';
  }
}

/**
 * Merges a new category into an accumulated category.
 *
 * @param current - The accumulated category (undefined when empty)
 * @param next - The next category seen
 * @returns The merged category
 */
export function mergeGeometryCategory(
  current: GeometryCategory | undefined,
  next: GeometryCategory,
): GeometryCategory {
  if (!current || current === 'unknown') return next;
  if (next === 'unknown') return current;
  return current === next ? current : 'mixed';
}

/**
 * Normalizes any GeoJSON object into a FeatureCollection.
 *
 * @param data - GeoJSON object (FeatureCollection, Feature, or Geometry)
 * @returns The data as a FeatureCollection
 */
export function toFeatureCollection(data: GeoJSON): FeatureCollection {
  if (data.type === 'FeatureCollection') return data;
  if (data.type === 'Feature') return { type: 'FeatureCollection', features: [data] };
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: data as Geometry, properties: {} }],
  };
}

function extendBboxWithPositions(bbox: Bbox, coords: unknown): void {
  if (!Array.isArray(coords)) return;
  if (typeof coords[0] === 'number') {
    const [x, y] = coords as Position;
    if (x < bbox[0]) bbox[0] = x;
    if (y < bbox[1]) bbox[1] = y;
    if (x > bbox[2]) bbox[2] = x;
    if (y > bbox[3]) bbox[3] = y;
    return;
  }
  for (const child of coords) {
    extendBboxWithPositions(bbox, child);
  }
}

function extendBboxWithGeometry(bbox: Bbox, geometry: Geometry | null): void {
  if (!geometry) return;
  if (geometry.type === 'GeometryCollection') {
    for (const child of geometry.geometries) {
      extendBboxWithGeometry(bbox, child);
    }
    return;
  }
  extendBboxWithPositions(bbox, geometry.coordinates);
}

/**
 * Summary statistics of a FeatureCollection.
 */
export interface GeoJSONSummary {
  featureCount: number;
  geometryType: GeometryCategory;
  bbox?: Bbox;
}

/**
 * Computes feature count, geometry category, and bounding box of a
 * FeatureCollection in a single pass.
 *
 * @param collection - The FeatureCollection to summarize
 * @returns Summary statistics
 */
export function summarizeFeatureCollection(collection: FeatureCollection): GeoJSONSummary {
  const bbox: Bbox = [Infinity, Infinity, -Infinity, -Infinity];
  let category: GeometryCategory | undefined;

  for (const feature of collection.features as Feature[]) {
    if (feature.geometry) {
      category = mergeGeometryCategory(category, classifyGeometryType(feature.geometry.type));
      extendBboxWithGeometry(bbox, feature.geometry);
    }
  }

  return {
    featureCount: collection.features.length,
    geometryType: category ?? 'unknown',
    bbox: bbox[0] <= bbox[2] && bbox[1] <= bbox[3] ? bbox : undefined,
  };
}
