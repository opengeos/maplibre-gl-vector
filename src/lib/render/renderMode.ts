import type { AutoThreshold, RenderMode } from '../core/types';

/**
 * Default thresholds for `'auto'` render mode.
 */
export const DEFAULT_AUTO_THRESHOLD: Required<AutoThreshold> = {
  featureCount: 50_000,
  byteSize: 25 * 1024 * 1024,
};

/**
 * Inputs for the render mode decision.
 */
export interface RenderModeInputs {
  /** Mode requested for the layer ('auto' when unspecified) */
  requested?: RenderMode;
  /** Control-level default mode */
  defaultMode?: RenderMode;
  /** Known feature count */
  featureCount?: number;
  /** Known source size in bytes */
  byteSize?: number;
  /** Threshold overrides */
  threshold?: AutoThreshold;
  /** Whether the tiles pipeline (DuckDB) is usable for this layer */
  tilesAvailable?: boolean;
}

/**
 * Resolves the effective render mode for a layer.
 *
 * Explicit per-layer modes win, then the control default, then 'auto'.
 * In auto mode, tiles are chosen when either the feature count or byte
 * size exceeds its threshold (and tiles are available).
 *
 * @param inputs - Decision inputs
 * @returns The resolved render mode ('geojson' or 'tiles')
 */
export function decideRenderMode(inputs: RenderModeInputs): 'geojson' | 'tiles' {
  const {
    requested,
    defaultMode,
    featureCount,
    byteSize,
    threshold,
    tilesAvailable = true,
  } = inputs;

  const mode = requested && requested !== 'auto' ? requested : (defaultMode ?? 'auto');

  if (mode === 'geojson') return 'geojson';
  if (mode === 'tiles') return tilesAvailable ? 'tiles' : 'geojson';

  if (!tilesAvailable) return 'geojson';

  const limits = { ...DEFAULT_AUTO_THRESHOLD, ...threshold };
  const tooManyFeatures = featureCount !== undefined && featureCount > limits.featureCount;
  const tooLarge = byteSize !== undefined && byteSize > limits.byteSize;

  return tooManyFeatures || tooLarge ? 'tiles' : 'geojson';
}
