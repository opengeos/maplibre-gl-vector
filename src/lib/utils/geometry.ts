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

/**
 * Reads the source CRS declared by a GeoJSON `crs` member and returns it as an
 * `EPSG:<code>` string to reproject from, or null when the collection is already
 * WGS84 lon/lat (or carries no usable CRS member).
 *
 * RFC 7946 mandates WGS84 for GeoJSON, but the pre-RFC form with a top-level
 * `"crs": { "type": "name", "properties": { "name": "urn:ogc:def:crs:EPSG::26911" } }`
 * is still emitted by GDAL/QGIS exports of projected data. Such a collection
 * carries raw projected coordinates (metres) that MapLibre cannot render, so the
 * caller reprojects to WGS84 before adding the layer. Both the URN form
 * (`urn:ogc:def:crs:EPSG::26911`) and the short form (`EPSG:26911`) are handled.
 *
 * WGS84 aliases (`EPSG:4326`, `EPSG:4979`, and OGC `CRS84`) return null so the
 * already-WGS84 common case skips the reprojection round-trip entirely.
 *
 * @param collection - A FeatureCollection that may carry a legacy `crs` member
 * @returns An `EPSG:<code>` string to reproject from, or null when none is needed
 */
export function crsFromGeoJSON(collection: FeatureCollection): string | null {
  const name = (collection as { crs?: { properties?: { name?: unknown } } }).crs?.properties?.name;
  if (typeof name !== 'string') return null;
  const upper = name.toUpperCase();
  // CRS84 (lon/lat) and the WGS84 EPSG codes are already the coordinates
  // MapLibre expects, so no reprojection is required.
  if (upper.includes('CRS84') || /EPSG:+(4326|4979)\b/.test(upper)) return null;
  // Match the trailing EPSG code in either the URN (`EPSG::26911`) or short
  // (`EPSG:26911`) form; the `:+` tolerates the URN's double colon.
  const match = upper.match(/EPSG:+(\d+)/);
  return match ? `EPSG:${match[1]}` : null;
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

/**
 * Collects the union of attribute (property) names across a collection's
 * features, in first-seen order. A host uses these to offer attribute-driven
 * choices (e.g. a label field) for a loaded layer.
 *
 * @param collection - The FeatureCollection to scan
 * @returns The distinct property names found across all features
 */
export function collectFieldNames(collection: FeatureCollection): string[] {
  const names = new Set<string>();
  for (const feature of collection.features as Feature[]) {
    if (!feature.properties) continue;
    for (const key of Object.keys(feature.properties)) names.add(key);
  }
  return Array.from(names);
}
