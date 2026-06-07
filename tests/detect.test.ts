import { describe, it, expect } from 'vitest';
import {
  baseName,
  detectSource,
  fileNameFromUrl,
  formatFromDataUrl,
  formatFromFileName,
} from '../src/lib/formats/detect';

describe('formatFromFileName', () => {
  it.each([
    ['data.geojson', 'geojson'],
    ['data.json', 'geojson'],
    ['data.GPKG', 'geopackage'],
    ['data.shp', 'shapefile'],
    ['data.zip', 'shapefile'],
    ['data.parquet', 'geoparquet'],
    ['data.geoparquet', 'geoparquet'],
    ['data.pq', 'geoparquet'],
    ['data.fgb', 'flatgeobuf'],
    ['data.csv', 'csv'],
    ['data.tsv', 'csv'],
    // GDAL-handled formats pass through as their extension
    ['data.kml', 'kml'],
    ['data.gml', 'gml'],
    ['data.xyz', 'xyz'],
    ['data', 'unknown'],
  ] as const)('detects %s as %s', (fileName, format) => {
    expect(formatFromFileName(fileName)).toBe(format);
  });
});

describe('fileNameFromUrl', () => {
  it('extracts the trailing segment', () => {
    expect(fileNameFromUrl('https://example.com/path/data.parquet')).toBe('data.parquet');
  });

  it('strips query strings and fragments', () => {
    expect(fileNameFromUrl('https://example.com/data.geojson?token=abc#x')).toBe('data.geojson');
  });
});

describe('baseName', () => {
  it('strips the extension', () => {
    expect(baseName('countries.geojson')).toBe('countries');
  });

  it('keeps names without extension', () => {
    expect(baseName('countries')).toBe('countries');
  });
});

describe('formatFromDataUrl', () => {
  it.each([
    ['data:application/geo+json;base64,e30=', 'geojson'],
    ['data:application/json,%7B%7D', 'geojson'],
    ['data:text/csv;base64,YQ==', 'csv'],
    ['data:application/vnd.apache.parquet;base64,AA==', 'geoparquet'],
    ['data:application/octet-stream;base64,AA==', 'unknown'],
  ] as const)('detects %s as %s', (url, format) => {
    expect(formatFromDataUrl(url)).toBe(format);
  });
});

describe('detectSource', () => {
  it('detects bundler-inlined GeoJSON data URLs by MIME type', () => {
    // Vite inlines small assets as base64 data URLs in production builds
    expect(detectSource('data:application/geo+json;base64,e30=').format).toBe('geojson');
  });

  it('detects URLs by extension', () => {
    expect(detectSource('https://example.com/buildings.parquet')).toEqual({
      format: 'geoparquet',
      name: 'buildings',
    });
  });

  it('detects Files by name', () => {
    const file = new File(['{}'], 'roads.gpkg');
    expect(detectSource(file)).toEqual({ format: 'geopackage', name: 'roads' });
  });

  it('treats plain objects as GeoJSON', () => {
    expect(detectSource({ type: 'FeatureCollection', features: [] })).toEqual({
      format: 'geojson',
      name: 'GeoJSON',
    });
  });

  it('prefers the explicit format', () => {
    expect(detectSource('https://example.com/data.bin', 'flatgeobuf').format).toBe('flatgeobuf');
  });
});
