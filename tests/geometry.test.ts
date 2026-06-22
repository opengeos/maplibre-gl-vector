import { describe, it, expect } from 'vitest';
import type { FeatureCollection } from 'geojson';
import {
  classifyGeometryType,
  collectFieldNames,
  mergeGeometryCategory,
  summarizeFeatureCollection,
  toFeatureCollection,
} from '../src/lib/utils/geometry';

describe('classifyGeometryType', () => {
  it.each([
    ['Point', 'point'],
    ['MultiPoint', 'point'],
    ['LineString', 'line'],
    ['MultiLineString', 'line'],
    ['Polygon', 'polygon'],
    ['MultiPolygon', 'polygon'],
    ['GeometryCollection', 'mixed'],
    ['Bogus', 'unknown'],
  ] as const)('classifies %s as %s', (type, category) => {
    expect(classifyGeometryType(type)).toBe(category);
  });
});

describe('mergeGeometryCategory', () => {
  it('keeps a matching category', () => {
    expect(mergeGeometryCategory('point', 'point')).toBe('point');
  });

  it('mixes differing categories', () => {
    expect(mergeGeometryCategory('point', 'polygon')).toBe('mixed');
  });

  it('starts from undefined', () => {
    expect(mergeGeometryCategory(undefined, 'line')).toBe('line');
  });

  it('ignores unknown', () => {
    expect(mergeGeometryCategory('line', 'unknown')).toBe('line');
  });
});

describe('toFeatureCollection', () => {
  it('passes FeatureCollections through', () => {
    const fc: FeatureCollection = { type: 'FeatureCollection', features: [] };
    expect(toFeatureCollection(fc)).toBe(fc);
  });

  it('wraps a Feature', () => {
    const result = toFeatureCollection({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [1, 2] },
      properties: { a: 1 },
    });
    expect(result.type).toBe('FeatureCollection');
    expect(result.features).toHaveLength(1);
  });

  it('wraps a bare Geometry', () => {
    const result = toFeatureCollection({ type: 'Point', coordinates: [1, 2] });
    expect(result.features[0].geometry).toEqual({ type: 'Point', coordinates: [1, 2] });
  });
});

describe('summarizeFeatureCollection', () => {
  it('computes count, category, and bbox', () => {
    const fc: FeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [10, 20] },
          properties: {},
        },
        {
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [
              [-5, -10],
              [15, 25],
            ],
          },
          properties: {},
        },
      ],
    };
    const summary = summarizeFeatureCollection(fc);
    expect(summary.featureCount).toBe(2);
    expect(summary.geometryType).toBe('mixed');
    expect(summary.bbox).toEqual([-5, -10, 15, 25]);
  });

  it('handles empty collections', () => {
    const summary = summarizeFeatureCollection({ type: 'FeatureCollection', features: [] });
    expect(summary.featureCount).toBe(0);
    expect(summary.geometryType).toBe('unknown');
    expect(summary.bbox).toBeUndefined();
  });

  it('skips null geometries', () => {
    const summary = summarizeFeatureCollection({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: null as never, properties: {} }],
    });
    expect(summary.featureCount).toBe(1);
    expect(summary.bbox).toBeUndefined();
  });
});

describe('collectFieldNames', () => {
  it('collects the union of property names in first-seen order', () => {
    const fc: FeatureCollection = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: null as never, properties: { name: 'a', pop: 1 } },
        { type: 'Feature', geometry: null as never, properties: { name: 'b', area: 2 } },
      ],
    };
    expect(collectFieldNames(fc)).toEqual(['name', 'pop', 'area']);
  });

  it('returns an empty array when no feature has properties', () => {
    const fc: FeatureCollection = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: null as never, properties: null }],
    };
    expect(collectFieldNames(fc)).toEqual([]);
  });
});
