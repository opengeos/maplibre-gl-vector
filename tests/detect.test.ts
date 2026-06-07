import { describe, it, expect } from 'vitest';
import {
  baseName,
  detectSource,
  fileNameFromUrl,
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
    ['data.xyz', 'unknown'],
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

describe('detectSource', () => {
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
