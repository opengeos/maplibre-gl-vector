import { describe, it, expect, vi } from 'vitest';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { fitMapToBbox, mercatorFitZoom } from '../src/lib/utils/fit';
import type { Bbox } from '../src/lib/utils/geometry';

/** The viewport the globe measurements in `fit.ts` were taken on. */
const VIEWPORT = { width: 576, height: 648 };

/**
 * The reported extent of the KMZ that motivated the ceiling: mostly the
 * United States, with three outliers in London, Osaka, and south-east Asia.
 */
const WIDE_BBOX: Bbox = [
  -124.1624694032033, 16.53894241180868, 135.5137398572391, 51.58247091548506,
];

function createMockMap(viewport: { width: number; height: number } | null = VIEWPORT) {
  return {
    fitBounds: vi.fn(),
    getCanvas: vi.fn(() => ({
      clientWidth: viewport?.width ?? 0,
      clientHeight: viewport?.height ?? 0,
    })),
  };
}

describe('mercatorFitZoom', () => {
  it('matches the zoom MapLibre settles on for a flat-map fit', () => {
    // Measured with map.fitBounds under the mercator projection on this
    // viewport: zoom 0.4254793721754276.
    expect(mercatorFitZoom(WIDE_BBOX, VIEWPORT, 40)).toBeCloseTo(0.4255, 3);
  });

  it('zooms further out the wider the extent gets', () => {
    const zooms = [10, 40, 90, 150, 259, 359].map(
      (width) => mercatorFitZoom([-width / 2, -10, width / 2, 10], VIEWPORT, 40) as number,
    );
    for (let i = 1; i < zooms.length; i += 1) {
      expect(zooms[i]).toBeLessThan(zooms[i - 1]);
    }
  });

  it('constrains on whichever axis is tighter', () => {
    // A tall, narrow box is limited by its height, not its width.
    const tall = mercatorFitZoom([-1, -60, 1, 60], VIEWPORT, 40) as number;
    const wide = mercatorFitZoom([-60, -1, 60, 1], VIEWPORT, 40) as number;
    expect(tall).toBeLessThan(wide);
  });

  it('ignores an axis with no extent', () => {
    // A horizontal line has no height; the width alone decides the zoom.
    const line = mercatorFitZoom([-60, 10, 60, 10], VIEWPORT, 40);
    const box = mercatorFitZoom([-60, 9.9, 60, 10.1], VIEWPORT, 40);
    expect(line).toBeCloseTo(box as number, 1);
  });

  it('returns undefined for a point-sized extent', () => {
    expect(mercatorFitZoom([5, 5, 5, 5], VIEWPORT, 40)).toBeUndefined();
  });

  it('returns undefined when padding leaves no room', () => {
    expect(mercatorFitZoom(WIDE_BBOX, { width: 60, height: 60 }, 40)).toBeUndefined();
  });

  it('returns undefined for a non-finite extent', () => {
    expect(mercatorFitZoom([Number.NaN, 0, 10, 10], VIEWPORT, 40)).toBeUndefined();
  });
});

describe('fitMapToBbox', () => {
  it('caps maxZoom at the flat-map fit so a wide extent cannot zoom in', () => {
    const map = createMockMap();
    fitMapToBbox(map as unknown as MapLibreMap, WIDE_BBOX, {
      padding: 40,
      duration: 600,
      maxZoom: 16,
    });

    expect(map.fitBounds).toHaveBeenCalledTimes(1);
    const [bounds, options] = map.fitBounds.mock.calls[0];
    expect(bounds).toEqual([
      [WIDE_BBOX[0], WIDE_BBOX[1]],
      [WIDE_BBOX[2], WIDE_BBOX[3]],
    ]);
    expect(options.padding).toBe(40);
    expect(options.duration).toBe(600);
    expect(options.maxZoom).toBeCloseTo(0.4255, 3);
  });

  it('keeps the caller ceiling when it is the tighter of the two', () => {
    const map = createMockMap();
    // A tiny extent fits well past zoom 16, so the caller's ceiling wins.
    fitMapToBbox(map as unknown as MapLibreMap, [-0.001, -0.001, 0.001, 0.001], {
      padding: 40,
      maxZoom: 16,
    });
    expect(map.fitBounds.mock.calls[0][1].maxZoom).toBe(16);
  });

  it('falls back to the caller ceiling when the viewport cannot be measured', () => {
    const map = createMockMap(null);
    fitMapToBbox(map as unknown as MapLibreMap, WIDE_BBOX, { padding: 40, maxZoom: 16 });
    expect(map.fitBounds.mock.calls[0][1].maxZoom).toBe(16);
  });

  it('omits maxZoom entirely when neither a ceiling nor a viewport applies', () => {
    const map = createMockMap(null);
    fitMapToBbox(map as unknown as MapLibreMap, WIDE_BBOX, { padding: 40 });
    expect(map.fitBounds.mock.calls[0][1]).not.toHaveProperty('maxZoom');
  });
});
