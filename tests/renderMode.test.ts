import { describe, it, expect } from 'vitest';
import { DEFAULT_AUTO_THRESHOLD, decideRenderMode } from '../src/lib/render/renderMode';

describe('decideRenderMode', () => {
  it('respects an explicit geojson request', () => {
    expect(decideRenderMode({ requested: 'geojson', featureCount: 10_000_000 })).toBe('geojson');
  });

  it('respects an explicit tiles request', () => {
    expect(decideRenderMode({ requested: 'tiles', featureCount: 1 })).toBe('tiles');
  });

  it('falls back to geojson when tiles are requested but unavailable', () => {
    expect(decideRenderMode({ requested: 'tiles', tilesAvailable: false })).toBe('geojson');
  });

  it('uses the control default when the layer does not specify a mode', () => {
    expect(decideRenderMode({ defaultMode: 'tiles', featureCount: 1 })).toBe('tiles');
  });

  it('auto picks geojson below the thresholds', () => {
    expect(decideRenderMode({ featureCount: 100, byteSize: 1024 })).toBe('geojson');
  });

  it('auto picks tiles above the feature count threshold', () => {
    expect(
      decideRenderMode({ featureCount: DEFAULT_AUTO_THRESHOLD.featureCount + 1 }),
    ).toBe('tiles');
  });

  it('auto picks tiles above the byte size threshold', () => {
    expect(decideRenderMode({ byteSize: DEFAULT_AUTO_THRESHOLD.byteSize + 1 })).toBe('tiles');
  });

  it('honors custom thresholds', () => {
    expect(
      decideRenderMode({ featureCount: 500, threshold: { featureCount: 100 } }),
    ).toBe('tiles');
    expect(
      decideRenderMode({ featureCount: 50, threshold: { featureCount: 100 } }),
    ).toBe('geojson');
  });

  it('auto picks geojson when sizes are unknown', () => {
    expect(decideRenderMode({})).toBe('geojson');
  });

  it('an explicit layer mode overrides the control default', () => {
    expect(decideRenderMode({ requested: 'geojson', defaultMode: 'tiles' })).toBe('geojson');
  });
});
