import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_STYLE,
  applyStyle,
  buildPaint,
  mapLayerId,
  stylePatchToPaintOps,
} from '../src/lib/render/styleBuilder';
import type { Map as MapLibreMap } from 'maplibre-gl';

describe('buildPaint', () => {
  it('builds fill paint', () => {
    expect(buildPaint('fill', DEFAULT_STYLE)).toEqual({
      'fill-color': '#3388ff',
      'fill-opacity': 0.4,
    });
  });

  it('builds line paint for outline and line roles', () => {
    const expected = { 'line-color': '#3388ff', 'line-width': 2 };
    expect(buildPaint('outline', DEFAULT_STYLE)).toEqual(expected);
    expect(buildPaint('line', DEFAULT_STYLE)).toEqual(expected);
  });

  it('builds circle paint with a white stroke', () => {
    expect(buildPaint('circle', DEFAULT_STYLE)).toMatchObject({
      'circle-color': '#3388ff',
      'circle-radius': 5,
      'circle-stroke-color': '#ffffff',
    });
  });
});

describe('stylePatchToPaintOps', () => {
  const info = {
    id: 'layer1',
    layerIds: ['layer1-fill', 'layer1-outline', 'layer1-line', 'layer1-circle'],
  };

  it('maps fill color to the fill layer only', () => {
    expect(stylePatchToPaintOps(info, { fillColor: '#ff0000' })).toEqual([
      { layerId: 'layer1-fill', property: 'fill-color', value: '#ff0000' },
    ]);
  });

  it('maps line color to outline and line layers', () => {
    expect(stylePatchToPaintOps(info, { lineColor: '#00ff00' })).toEqual([
      { layerId: 'layer1-outline', property: 'line-color', value: '#00ff00' },
      { layerId: 'layer1-line', property: 'line-color', value: '#00ff00' },
    ]);
  });

  it('skips layers the vector layer does not have', () => {
    const pointOnly = { id: 'pts', layerIds: ['pts-circle'] };
    expect(stylePatchToPaintOps(pointOnly, { fillColor: '#fff', circleRadius: 8 })).toEqual([
      { layerId: 'pts-circle', property: 'circle-radius', value: 8 },
    ]);
  });

  it('ignores undefined values', () => {
    expect(stylePatchToPaintOps(info, {})).toEqual([]);
  });
});

describe('applyStyle', () => {
  it('calls setPaintProperty for each op', () => {
    const map = { setPaintProperty: vi.fn() } as unknown as MapLibreMap;
    applyStyle(map, { id: 'a', layerIds: ['a-fill'] }, { fillOpacity: 0.9 });
    expect(map.setPaintProperty).toHaveBeenCalledExactlyOnceWith('a-fill', 'fill-opacity', 0.9);
  });
});

describe('mapLayerId', () => {
  it('joins the layer id and suffix', () => {
    expect(mapLayerId('abc', 'circle')).toBe('abc-circle');
  });
});
