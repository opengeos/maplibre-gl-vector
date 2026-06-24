import { describe, it, expect } from 'vitest';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { VectorLayerStyle } from '../src/lib/core/types';
import {
  DEFAULT_STYLE,
  buildPaint,
  opacityToPaintOps,
  stylePatchToPaintOps,
} from '../src/lib/render/styleBuilder';
import { addGeometryLayers, suffixesForGeometry } from '../src/lib/render/mapSources';

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

describe('suffixesForGeometry with extrusion', () => {
  it('replaces the flat polygon roles with a single extrusion role', () => {
    expect(suffixesForGeometry('polygon', false)).toEqual(['fill', 'outline']);
    expect(suffixesForGeometry('polygon', true)).toEqual(['extrusion']);
  });

  it('swaps fill/outline for extrusion in mixed geometry, leaving line/circle', () => {
    expect(suffixesForGeometry('mixed', true)).toEqual(['extrusion', 'line', 'circle']);
    expect(suffixesForGeometry('unknown', true)).toEqual(['extrusion', 'line', 'circle']);
  });

  it('does not extrude line or point geometry', () => {
    expect(suffixesForGeometry('line', true)).toEqual(['line']);
    expect(suffixesForGeometry('point', true)).toEqual(['circle']);
  });
});

describe('buildPaint for the extrusion role', () => {
  it('falls back to the fill color and a flat (0) height when unset', () => {
    expect(buildPaint('extrusion', style())).toEqual({
      'fill-extrusion-color': '#3388ff',
      'fill-extrusion-opacity': 1,
      'fill-extrusion-height': 0,
      'fill-extrusion-base': 0,
    });
  });

  it('honors a data-driven height expression and the extrusion color/base', () => {
    const paint = buildPaint(
      'extrusion',
      style({
        extrusionEnabled: true,
        extrusionColor: '#ff0000',
        extrusionHeight: ['get', 'height'] as unknown as VectorLayerStyle['extrusionHeight'],
        extrusionBase: 2,
      }),
    );
    expect(paint['fill-extrusion-color']).toBe('#ff0000');
    expect(paint['fill-extrusion-height']).toEqual(['get', 'height']);
    expect(paint['fill-extrusion-base']).toBe(2);
  });

  it('prefers the data-driven color expression over the flat extrusion color', () => {
    const expr = ['match', ['get', 'k'], 'a', '#111', '#222'] as unknown as NonNullable<
      VectorLayerStyle['extrusionColorExpression']
    >;
    const paint = buildPaint(
      'extrusion',
      style({ extrusionColor: '#ff0000', extrusionColorExpression: expr }),
    );
    expect(paint['fill-extrusion-color']).toEqual(expr);
  });

  it('multiplies the master opacity into the extrusion opacity', () => {
    const paint = buildPaint('extrusion', style({ extrusionOpacity: 0.8 }), 0.5);
    expect(paint['fill-extrusion-opacity']).toBe(0.4);
  });
});

describe('addGeometryLayers with extrusion', () => {
  it('creates a fill-extrusion layer (and no flat fill) for an extruded polygon layer', () => {
    const { map, layers } = fakeMap();
    const ids = addGeometryLayers(map, {
      layerId: 'lyr',
      geometryType: 'polygon',
      style: style({ extrusionEnabled: true, extrusionHeight: 10 }),
      visible: true,
    });
    expect(ids).toEqual(['lyr-extrusion']);
    expect(layers.get('lyr-extrusion')?.type).toBe('fill-extrusion');
    expect(layers.has('lyr-fill')).toBe(false);
    expect(layers.has('lyr-outline')).toBe(false);
    // MapLibre reports MultiPolygon features as "Polygon", so the Polygon
    // filter still matches them.
    expect(layers.get('lyr-extrusion')?.filter).toEqual(['==', ['geometry-type'], 'Polygon']);
  });

  it('creates a flat fill (no extrusion) when extrusion is off', () => {
    const { map, layers } = fakeMap();
    const ids = addGeometryLayers(map, {
      layerId: 'lyr',
      geometryType: 'polygon',
      style: style(),
      visible: true,
    });
    expect(ids).toEqual(['lyr-fill', 'lyr-outline']);
    expect(layers.has('lyr-extrusion')).toBe(false);
  });
});

describe('stylePatchToPaintOps for extrusion', () => {
  const info = { id: 'lyr', layerIds: ['lyr-extrusion'] };

  it('emits fill-extrusion paint ops only for a layer with the extrusion role', () => {
    const ops = stylePatchToPaintOps(info, {
      extrusionColor: '#abcdef',
      extrusionHeight: ['get', 'h'] as unknown as VectorLayerStyle['extrusionHeight'],
      extrusionBase: 1,
      extrusionOpacity: 0.5,
    });
    expect(ops).toContainEqual({
      layerId: 'lyr-extrusion',
      property: 'fill-extrusion-color',
      value: '#abcdef',
    });
    expect(ops).toContainEqual({
      layerId: 'lyr-extrusion',
      property: 'fill-extrusion-height',
      value: ['get', 'h'],
    });
    expect(ops).toContainEqual({
      layerId: 'lyr-extrusion',
      property: 'fill-extrusion-base',
      value: 1,
    });
    expect(ops).toContainEqual({
      layerId: 'lyr-extrusion',
      property: 'fill-extrusion-opacity',
      value: 0.5,
    });
  });

  it('skips extrusion ops when the layer has no extrusion role', () => {
    const ops = stylePatchToPaintOps(
      { id: 'lyr', layerIds: ['lyr-fill', 'lyr-outline'] },
      { extrusionColor: '#abcdef' },
    );
    expect(ops.some((op) => op.property.startsWith('fill-extrusion'))).toBe(false);
  });

  it('multiplies the master opacity into a pushed extrusion opacity', () => {
    const ops = stylePatchToPaintOps(info, { extrusionOpacity: 0.8 }, 0.5);
    expect(ops).toContainEqual({
      layerId: 'lyr-extrusion',
      property: 'fill-extrusion-opacity',
      value: 0.4,
    });
  });
});

describe('opacityToPaintOps for extrusion', () => {
  it('multiplies the style extrusion opacity by the master opacity', () => {
    const ops = opacityToPaintOps(
      { id: 'lyr', layerIds: ['lyr-extrusion'] },
      style({ extrusionOpacity: 0.6 }),
      0.5,
    );
    expect(ops).toContainEqual({
      layerId: 'lyr-extrusion',
      property: 'fill-extrusion-opacity',
      value: 0.3,
    });
  });
});
