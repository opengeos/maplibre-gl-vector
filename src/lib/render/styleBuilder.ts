import type { Map as MapLibreMap } from 'maplibre-gl';
import type { VectorLayerInfo, VectorLayerStyle } from '../core/types';

/**
 * Default style applied to new layers.
 */
export const DEFAULT_STYLE: VectorLayerStyle = {
  fillColor: '#3388ff',
  fillOpacity: 0.4,
  lineColor: '#3388ff',
  lineWidth: 2,
  circleColor: '#3388ff',
  circleRadius: 5,
  circleOpacity: 0.85,
};

/**
 * A single setPaintProperty operation.
 */
export interface PaintOp {
  layerId: string;
  property: string;
  value: string | number;
}

/**
 * Suffixes of the map layers created for each vector layer.
 */
export const LAYER_SUFFIXES = ['fill', 'outline', 'line', 'circle'] as const;
export type LayerSuffix = (typeof LAYER_SUFFIXES)[number];

/**
 * Builds the map layer id for a vector layer and suffix.
 *
 * @param layerId - The vector layer id
 * @param suffix - The map layer role
 * @returns The map layer id
 */
export function mapLayerId(layerId: string, suffix: LayerSuffix): string {
  return `${layerId}-${suffix}`;
}

/**
 * Builds the initial paint object for a given map layer role.
 *
 * @param suffix - The map layer role
 * @param style - The layer style
 * @returns The MapLibre paint object
 */
export function buildPaint(
  suffix: LayerSuffix,
  style: VectorLayerStyle,
): Record<string, string | number> {
  switch (suffix) {
    case 'fill':
      return {
        'fill-color': style.fillColor,
        'fill-opacity': style.fillOpacity,
      };
    case 'outline':
      return {
        'line-color': style.lineColor,
        'line-width': style.lineWidth,
      };
    case 'line':
      return {
        'line-color': style.lineColor,
        'line-width': style.lineWidth,
      };
    case 'circle':
      return {
        'circle-color': style.circleColor,
        'circle-radius': style.circleRadius,
        'circle-opacity': style.circleOpacity,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1,
      };
  }
}

/**
 * Maps a style patch to the setPaintProperty operations it implies.
 *
 * Only operations for map layers that exist on the vector layer are
 * returned.
 *
 * @param info - The vector layer
 * @param patch - Partial style update
 * @returns The list of paint operations to apply
 */
export function stylePatchToPaintOps(
  info: Pick<VectorLayerInfo, 'id' | 'layerIds'>,
  patch: Partial<VectorLayerStyle>,
): PaintOp[] {
  const ops: PaintOp[] = [];
  const has = (suffix: LayerSuffix) => info.layerIds.includes(mapLayerId(info.id, suffix));
  const push = (suffix: LayerSuffix, property: string, value: string | number | undefined) => {
    if (value !== undefined && has(suffix)) {
      ops.push({ layerId: mapLayerId(info.id, suffix), property, value });
    }
  };

  push('fill', 'fill-color', patch.fillColor);
  push('fill', 'fill-opacity', patch.fillOpacity);
  push('outline', 'line-color', patch.lineColor);
  push('outline', 'line-width', patch.lineWidth);
  push('line', 'line-color', patch.lineColor);
  push('line', 'line-width', patch.lineWidth);
  push('circle', 'circle-color', patch.circleColor);
  push('circle', 'circle-radius', patch.circleRadius);
  push('circle', 'circle-opacity', patch.circleOpacity);

  return ops;
}

/**
 * Applies a style patch to the map layers of a vector layer.
 *
 * @param map - The MapLibre map
 * @param info - The vector layer
 * @param patch - Partial style update
 */
export function applyStyle(
  map: MapLibreMap,
  info: Pick<VectorLayerInfo, 'id' | 'layerIds'>,
  patch: Partial<VectorLayerStyle>,
): void {
  for (const op of stylePatchToPaintOps(info, patch)) {
    map.setPaintProperty(op.layerId, op.property, op.value);
  }
}
