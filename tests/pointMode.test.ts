import { describe, it, expect } from 'vitest';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { VectorLayerStyle } from '../src/lib/core/types';
import {
  DEFAULT_STYLE,
  buildPaint,
  pointModeOf,
  stylePatchToPaintOps,
} from '../src/lib/render/styleBuilder';
import {
  addGeometryLayers,
  addGeoJSONSource,
  clusterOptionsFor,
} from '../src/lib/render/mapSources';
import type { FeatureCollection } from 'geojson';

function style(patch: Partial<VectorLayerStyle> = {}): VectorLayerStyle {
  return { ...DEFAULT_STYLE, ...patch };
}

// Minimal fake map recording the layers and sources created.
function fakeMap() {
  const layers = new Map<string, Record<string, unknown>>();
  const sources = new Map<string, Record<string, unknown>>();
  const map = {
    addLayer: (spec: Record<string, unknown>) => layers.set(spec.id as string, spec),
    getLayer: (id: string) => layers.get(id),
    addSource: (id: string, spec: Record<string, unknown>) => sources.set(id, spec),
    getSource: (id: string) => sources.get(id),
  } as unknown as MapLibreMap;
  return { map, layers, sources };
}

const FC: FeatureCollection = { type: 'FeatureCollection', features: [] };

describe('pointModeOf', () => {
  it('defaults to circle', () => {
    expect(pointModeOf(style())).toBe('circle');
    expect(pointModeOf(style({ pointMode: 'heatmap' }))).toBe('heatmap');
  });
});

describe('clusterOptionsFor', () => {
  it('returns cluster options only for clustered geojson point layers', () => {
    expect(clusterOptionsFor('point', style({ pointMode: 'cluster' }))).toEqual({
      radius: 50,
      maxZoom: 14,
    });
    expect(
      clusterOptionsFor('point', style({ pointMode: 'cluster', clusterRadius: 30, clusterMaxZoom: 10 })),
    ).toEqual({ radius: 30, maxZoom: 10 });
    // Not clustered, not point, or tile-backed → undefined.
    expect(clusterOptionsFor('point', style({ pointMode: 'heatmap' }))).toBeUndefined();
    expect(clusterOptionsFor('polygon', style({ pointMode: 'cluster' }))).toBeUndefined();
    expect(clusterOptionsFor('point', style({ pointMode: 'cluster' }), 'roads')).toBeUndefined();
  });
});

describe('buildPaint', () => {
  it('builds a heatmap paint with radius/intensity/color', () => {
    const paint = buildPaint('heatmap', style({ heatmapRadius: 42, heatmapIntensity: 2 }), 0.5);
    expect(paint['heatmap-radius']).toBe(42);
    expect(paint['heatmap-intensity']).toBe(2);
    expect(paint['heatmap-opacity']).toBe(0.5);
    expect(Array.isArray(paint['heatmap-color'])).toBe(true);
  });

  it('builds a cluster circle paint from the circle color with a stepped radius', () => {
    const paint = buildPaint('cluster', style({ circleColor: '#abcdef' }));
    expect(paint['circle-color']).toBe('#abcdef');
    expect(Array.isArray(paint['circle-radius'])).toBe(true);
  });
});

describe('addGeoJSONSource clustering', () => {
  it('adds cluster options to the source spec when requested', () => {
    const { map, sources } = fakeMap();
    addGeoJSONSource(map, 'pts', FC, undefined, { radius: 40, maxZoom: 12 });
    const spec = sources.get('pts-source')!;
    expect(spec.cluster).toBe(true);
    expect(spec.clusterRadius).toBe(40);
    expect(spec.clusterMaxZoom).toBe(12);
  });

  it('omits cluster options by default', () => {
    const { map, sources } = fakeMap();
    addGeoJSONSource(map, 'pts', FC);
    expect(sources.get('pts-source')!.cluster).toBeUndefined();
  });
});

describe('addGeometryLayers point modes', () => {
  const base = { layerId: 'pts', geometryType: 'point' as const, visible: true };

  it('creates a single circle layer by default', () => {
    const { map, layers } = fakeMap();
    const ids = addGeometryLayers(map, { ...base, style: style() });
    expect(ids).toEqual(['pts-circle']);
    expect(layers.get('pts-circle')!.type).toBe('circle');
  });

  it('creates a heatmap layer for pointMode heatmap', () => {
    const { map, layers } = fakeMap();
    const ids = addGeometryLayers(map, { ...base, style: style({ pointMode: 'heatmap' }) });
    expect(ids).toEqual(['pts-heatmap']);
    expect(layers.get('pts-heatmap')!.type).toBe('heatmap');
  });

  it('creates cluster, count, and unclustered layers for pointMode cluster', () => {
    const { map, layers } = fakeMap();
    const ids = addGeometryLayers(map, { ...base, style: style({ pointMode: 'cluster' }) });
    expect(ids).toEqual(['pts-cluster', 'pts-cluster-count', 'pts-circle']);
    expect(layers.get('pts-cluster')!.type).toBe('circle');
    expect(layers.get('pts-cluster-count')!.type).toBe('symbol');
    expect(layers.get('pts-circle')!.filter).toEqual(['!', ['has', 'point_count']]);
  });

  it('ignores pointMode for tile-backed point layers (always circle)', () => {
    const { map, layers } = fakeMap();
    const ids = addGeometryLayers(map, {
      ...base,
      style: style({ pointMode: 'cluster' }),
      sourceLayer: 'pts',
    });
    expect(ids).toEqual(['pts-circle']);
    expect(layers.get('pts-circle')!.type).toBe('circle');
  });
});

describe('stylePatchToPaintOps', () => {
  it('emits heatmap radius/intensity ops for an existing heatmap layer', () => {
    const ops = stylePatchToPaintOps(
      { id: 'pts', layerIds: ['pts-heatmap'] },
      { heatmapRadius: 25, heatmapIntensity: 3 },
    );
    expect(ops).toContainEqual({ layerId: 'pts-heatmap', property: 'heatmap-radius', value: 25 });
    expect(ops).toContainEqual({
      layerId: 'pts-heatmap',
      property: 'heatmap-intensity',
      value: 3,
    });
  });
});
