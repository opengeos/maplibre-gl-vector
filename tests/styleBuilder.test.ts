import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_STYLE,
  applyOpacity,
  applyStyle,
  buildPaint,
  clampOpacity,
  mapLayerId,
  opacityToPaintOps,
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
    const expected = { 'line-color': '#3388ff', 'line-width': 2, 'line-opacity': 1 };
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

  it('multiplies the master opacity into every opacity property', () => {
    expect(buildPaint('fill', DEFAULT_STYLE, 0.5)).toMatchObject({
      'fill-opacity': DEFAULT_STYLE.fillOpacity * 0.5,
    });
    expect(buildPaint('line', DEFAULT_STYLE, 0.5)).toMatchObject({ 'line-opacity': 0.5 });
    expect(buildPaint('circle', DEFAULT_STYLE, 0.5)).toMatchObject({
      'circle-opacity': DEFAULT_STYLE.circleOpacity * 0.5,
      'circle-stroke-opacity': 0.5,
    });
  });
});

describe('buildPaint data-driven color', () => {
  const matchExpr = [
    'match',
    ['to-string', ['get', 'continent']],
    'Asia',
    '#ff0000',
    '#cccccc',
  ];

  it('uses fillColorExpression over the flat fill color', () => {
    expect(
      buildPaint('fill', { ...DEFAULT_STYLE, fillColorExpression: matchExpr }),
    ).toMatchObject({ 'fill-color': matchExpr });
  });

  it('uses lineColorExpression for outline and line roles', () => {
    const style = { ...DEFAULT_STYLE, lineColorExpression: matchExpr };
    expect(buildPaint('outline', style)).toMatchObject({ 'line-color': matchExpr });
    expect(buildPaint('line', style)).toMatchObject({ 'line-color': matchExpr });
  });

  it('uses circleColorExpression over the flat circle color', () => {
    expect(
      buildPaint('circle', { ...DEFAULT_STYLE, circleColorExpression: matchExpr }),
    ).toMatchObject({ 'circle-color': matchExpr });
  });
});

describe('clampOpacity', () => {
  it('clamps to [0, 1] and maps non-finite values to 1', () => {
    expect(clampOpacity(-0.5)).toBe(0);
    expect(clampOpacity(0.3)).toBe(0.3);
    expect(clampOpacity(2)).toBe(1);
    expect(clampOpacity(Number.NaN)).toBe(1);
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

  it('prefers a color expression over the flat color', () => {
    const fillExpr = ['match', ['get', 'k'], 'a', '#f00', '#ccc'];
    const lineExpr = ['match', ['get', 'k'], 'a', '#0f0', '#ccc'];
    const circleExpr = ['match', ['get', 'k'], 'a', '#00f', '#ccc'];
    expect(
      stylePatchToPaintOps(info, {
        fillColor: '#111111',
        fillColorExpression: fillExpr,
        lineColor: '#222222',
        lineColorExpression: lineExpr,
        circleColor: '#333333',
        circleColorExpression: circleExpr,
      }),
    ).toEqual([
      { layerId: 'layer1-fill', property: 'fill-color', value: fillExpr },
      { layerId: 'layer1-outline', property: 'line-color', value: lineExpr },
      { layerId: 'layer1-line', property: 'line-color', value: lineExpr },
      { layerId: 'layer1-circle', property: 'circle-color', value: circleExpr },
    ]);
  });

  it('falls back to the flat color when the expression is explicitly undefined', () => {
    // Reverting from a data-driven mode: the host clears the expression and
    // sends the flat color, which must reach the map.
    expect(
      stylePatchToPaintOps(info, {
        fillColor: '#abcdef',
        fillColorExpression: undefined,
      }),
    ).toEqual([{ layerId: 'layer1-fill', property: 'fill-color', value: '#abcdef' }]);
  });

  it('multiplies opacity patches by the master opacity', () => {
    expect(stylePatchToPaintOps(info, { fillOpacity: 0.8, circleOpacity: 0.6 }, 0.5)).toEqual([
      { layerId: 'layer1-fill', property: 'fill-opacity', value: 0.4 },
      { layerId: 'layer1-circle', property: 'circle-opacity', value: 0.3 },
    ]);
  });
});

describe('opacityToPaintOps', () => {
  it('maps a master opacity change onto every opacity property', () => {
    const info = {
      id: 'layer1',
      layerIds: ['layer1-fill', 'layer1-outline', 'layer1-line', 'layer1-circle'],
    };
    expect(opacityToPaintOps(info, DEFAULT_STYLE, 0.5)).toEqual([
      {
        layerId: 'layer1-fill',
        property: 'fill-opacity',
        value: DEFAULT_STYLE.fillOpacity * 0.5,
      },
      { layerId: 'layer1-outline', property: 'line-opacity', value: 0.5 },
      { layerId: 'layer1-line', property: 'line-opacity', value: 0.5 },
      {
        layerId: 'layer1-circle',
        property: 'circle-opacity',
        value: DEFAULT_STYLE.circleOpacity * 0.5,
      },
      { layerId: 'layer1-circle', property: 'circle-stroke-opacity', value: 0.5 },
    ]);
  });

  it('skips layers the vector layer does not have', () => {
    const lineOnly = { id: 'rds', layerIds: ['rds-line'] };
    expect(opacityToPaintOps(lineOnly, DEFAULT_STYLE, 0.25)).toEqual([
      { layerId: 'rds-line', property: 'line-opacity', value: 0.25 },
    ]);
  });
});

describe('applyStyle', () => {
  it('calls setPaintProperty for each op', () => {
    const map = { setPaintProperty: vi.fn() } as unknown as MapLibreMap;
    applyStyle(map, { id: 'a', layerIds: ['a-fill'] }, { fillOpacity: 0.9 });
    expect(map.setPaintProperty).toHaveBeenCalledExactlyOnceWith('a-fill', 'fill-opacity', 0.9);
  });
});

describe('applyOpacity', () => {
  it('calls setPaintProperty for each op', () => {
    const map = { setPaintProperty: vi.fn() } as unknown as MapLibreMap;
    applyOpacity(map, { id: 'a', layerIds: ['a-fill'] }, DEFAULT_STYLE, 0.5);
    expect(map.setPaintProperty).toHaveBeenCalledExactlyOnceWith(
      'a-fill',
      'fill-opacity',
      DEFAULT_STYLE.fillOpacity * 0.5,
    );
  });
});

describe('mapLayerId', () => {
  it('joins the layer id and suffix', () => {
    expect(mapLayerId('abc', 'circle')).toBe('abc-circle');
  });
});
