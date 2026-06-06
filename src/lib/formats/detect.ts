import type { VectorDataSource, VectorFormat } from '../core/types';

/**
 * Result of format detection for a data source.
 */
export interface DetectedSource {
  /** Detected vector format */
  format: VectorFormat;
  /** Suggested display name (file name without extension, or 'GeoJSON') */
  name: string;
}

/**
 * Maps file extensions to vector formats.
 */
const EXTENSION_FORMATS: Record<string, VectorFormat> = {
  geojson: 'geojson',
  json: 'geojson',
  gpkg: 'geopackage',
  shp: 'shapefile',
  zip: 'shapefile',
  parquet: 'geoparquet',
  geoparquet: 'geoparquet',
  pq: 'geoparquet',
  fgb: 'flatgeobuf',
  csv: 'csv',
  tsv: 'csv',
};

/**
 * Extracts the file name from a URL or path, stripping query strings.
 *
 * @param url - URL or file path
 * @returns The trailing file name segment
 */
export function fileNameFromUrl(url: string): string {
  const withoutQuery = url.split(/[?#]/)[0];
  const segments = withoutQuery.split('/');
  return segments[segments.length - 1] || withoutQuery;
}

/**
 * Detects the vector format from a file name based on its extension.
 *
 * @param fileName - File name or URL path
 * @returns The detected format, or 'unknown' if unrecognized
 */
export function formatFromFileName(fileName: string): VectorFormat {
  const match = /\.([a-z0-9]+)$/i.exec(fileName.trim());
  if (!match) return 'unknown';
  return EXTENSION_FORMATS[match[1].toLowerCase()] ?? 'unknown';
}

/**
 * Strips the extension from a file name for display purposes.
 *
 * @param fileName - File name
 * @returns File name without its extension
 */
export function baseName(fileName: string): string {
  return fileName.replace(/\.[a-z0-9]+$/i, '') || fileName;
}

/**
 * Detects the format and display name of a data source.
 *
 * GeoJSON objects are recognized directly; files and URLs are detected
 * from their extension. An explicit format always wins.
 *
 * @param source - URL string, File/Blob, or GeoJSON object
 * @param explicitFormat - Optional format override
 * @returns The detected source description
 */
export function detectSource(
  source: VectorDataSource,
  explicitFormat?: VectorFormat,
): DetectedSource {
  if (typeof source === 'string') {
    const name = fileNameFromUrl(source);
    return {
      format: explicitFormat ?? formatFromFileName(name),
      name: baseName(name),
    };
  }

  if (typeof File !== 'undefined' && source instanceof File) {
    return {
      format: explicitFormat ?? formatFromFileName(source.name),
      name: baseName(source.name),
    };
  }

  if (typeof Blob !== 'undefined' && source instanceof Blob) {
    return { format: explicitFormat ?? 'unknown', name: 'Untitled' };
  }

  // Plain object - treat as GeoJSON
  return { format: explicitFormat ?? 'geojson', name: 'GeoJSON' };
}
