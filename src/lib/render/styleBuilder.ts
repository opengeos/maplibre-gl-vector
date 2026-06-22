import type { Map as MapLibreMap, PropertyValueSpecification } from 'maplibre-gl';
import type { VectorLayerInfo, VectorLayerStyle } from '../core/types';

/**
 * A paint value: a flat scalar, or a MapLibre data-driven color expression
 * (used for attribute-driven fill/line/circle colors).
 */
export type PaintValue =
  | string
  | number
  | PropertyValueSpecification<string>
  | PropertyValueSpecification<number>;

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
  pointMode: 'circle',
  heatmapRadius: 30,
  heatmapIntensity: 1,
  clusterRadius: 50,
  clusterMaxZoom: 14,
};

// A cold->hot ramp over heatmap-density (0..1) for the heatmap renderer.
const HEATMAP_COLOR: PropertyValueSpecification<string> = [
  'interpolate',
  ['linear'],
  ['heatmap-density'],
  0,
  'rgba(33,102,172,0)',
  0.2,
  'rgb(103,169,207)',
  0.4,
  'rgb(209,229,240)',
  0.6,
  'rgb(253,219,199)',
  0.8,
  'rgb(239,138,98)',
  1,
  'rgb(178,24,43)',
] as unknown as PropertyValueSpecification<string>;

// Cluster bubble radius steps up with the aggregated point count.
const CLUSTER_RADIUS: PropertyValueSpecification<number> = [
  'step',
  ['get', 'point_count'],
  16,
  50,
  22,
  200,
  30,
] as unknown as PropertyValueSpecification<number>;

/**
 * A single setPaintProperty operation.
 */
export interface PaintOp {
  layerId: string;
  property: string;
  value: PaintValue;
}

/**
 * Suffixes of the map layers created for each vector layer.
 */
export const LAYER_SUFFIXES = [
  'fill',
  'outline',
  'line',
  'circle',
  'heatmap',
  'cluster',
  'cluster-count',
  'label',
] as const;
export type LayerSuffix = (typeof LAYER_SUFFIXES)[number];

/** Default size, in pixels, of attribute label text. */
export const DEFAULT_LABEL_SIZE = 12;
/** Default color of attribute label text. */
export const DEFAULT_LABEL_COLOR = '#333333';
/** Default color of the halo drawn behind attribute label text. */
export const DEFAULT_LABEL_HALO_COLOR = '#ffffff';
/** Default width, in pixels, of the attribute label text halo. */
export const DEFAULT_LABEL_HALO_WIDTH = 1;

/** Resolve a style's point render mode, defaulting to 'circle'. */
export function pointModeOf(style: VectorLayerStyle): 'circle' | 'heatmap' | 'cluster' {
  return style.pointMode ?? 'circle';
}

/**
 * Whether a style requests attribute labels (a non-empty `labelField`).
 *
 * @param style - The layer style
 * @returns True when a label layer should be created
 */
export function hasLabels(style: VectorLayerStyle): boolean {
  return typeof style.labelField === 'string' && style.labelField.trim().length > 0;
}

/**
 * Builds the `text-field` expression for a label layer: the feature's
 * `labelField` value coerced to a string, with missing values rendered as
 * empty text (so a cluster aggregate or a feature lacking the field shows
 * nothing rather than breaking the layer).
 *
 * @param style - The layer style (its `labelField` drives the expression)
 * @returns A MapLibre `text-field` expression
 */
export function labelTextField(style: VectorLayerStyle): PropertyValueSpecification<string> {
  return [
    'to-string',
    ['coalesce', ['get', style.labelField ?? ''], ''],
  ] as unknown as PropertyValueSpecification<string>;
}

/**
 * Builds the symbol-layer layout for a label layer.
 *
 * @param style - The layer style
 * @param visible - Whether the layer starts visible
 * @returns The MapLibre layout object for the label symbol layer
 */
export function buildLabelLayout(
  style: VectorLayerStyle,
  visible: boolean,
): Record<string, unknown> {
  const allowOverlap = style.labelAllowOverlap ?? false;
  return {
    visibility: visible ? 'visible' : 'none',
    'text-field': labelTextField(style),
    'text-size': style.labelSize ?? DEFAULT_LABEL_SIZE,
    'symbol-placement': style.labelPlacement === 'line' ? 'line' : 'point',
    'text-allow-overlap': allowOverlap,
    'text-ignore-placement': allowOverlap,
  };
}

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
 * Clamps a master opacity value to the valid [0, 1] range.
 *
 * @param opacity - The requested opacity
 * @returns The clamped opacity (non-finite values become 1)
 */
export function clampOpacity(opacity: number): number {
  if (!Number.isFinite(opacity)) return 1;
  return Math.min(1, Math.max(0, opacity));
}

/**
 * Builds the initial paint object for a given map layer role.
 *
 * @param suffix - The map layer role
 * @param style - The layer style
 * @param opacity - Master opacity multiplied into every opacity property
 * @returns The MapLibre paint object
 */
export function buildPaint(
  suffix: LayerSuffix,
  style: VectorLayerStyle,
  opacity = 1,
): Record<string, PaintValue> {
  const master = clampOpacity(opacity);
  // A data-driven color expression, when present, overrides the flat color so
  // attribute-driven (categorized/graduated) styling renders.
  const fillColor = style.fillColorExpression ?? style.fillColor;
  const lineColor = style.lineColorExpression ?? style.lineColor;
  const circleColor = style.circleColorExpression ?? style.circleColor;
  switch (suffix) {
    case 'fill':
      return {
        'fill-color': fillColor,
        'fill-opacity': style.fillOpacity * master,
      };
    case 'outline':
      return {
        'line-color': lineColor,
        'line-width': style.lineWidth,
        'line-opacity': master,
      };
    case 'line':
      return {
        'line-color': lineColor,
        'line-width': style.lineWidth,
        'line-opacity': master,
      };
    case 'circle':
      return {
        'circle-color': circleColor,
        'circle-radius': style.circleRadius,
        'circle-opacity': style.circleOpacity * master,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1,
        'circle-stroke-opacity': master,
      };
    case 'heatmap':
      return {
        'heatmap-radius': style.heatmapRadius ?? 30,
        'heatmap-intensity': style.heatmapIntensity ?? 1,
        'heatmap-opacity': master,
        'heatmap-color': HEATMAP_COLOR,
      };
    case 'cluster':
      return {
        // Use the resolved circleColor (data-driven expression or flat) so an
        // initial cluster render honors the same color contract as a later patch.
        'circle-color': circleColor,
        'circle-radius': CLUSTER_RADIUS,
        'circle-opacity': style.circleOpacity * master,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1,
        'circle-stroke-opacity': master,
      };
    case 'cluster-count':
      return {
        'text-color': '#ffffff',
        'text-opacity': master,
      };
    case 'label':
      return {
        'text-color': style.labelColor ?? DEFAULT_LABEL_COLOR,
        'text-halo-color': style.labelHaloColor ?? DEFAULT_LABEL_HALO_COLOR,
        'text-halo-width': Math.max(0, style.labelHaloWidth ?? DEFAULT_LABEL_HALO_WIDTH),
        'text-opacity': master,
      };
  }
}

/**
 * Maps a style patch to the setPaintProperty operations it implies.
 *
 * Only operations for map layers that exist on the vector layer are
 * returned. Style opacities are multiplied by the layer's master
 * opacity so a patch cannot undo a host-applied opacity.
 *
 * @param info - The vector layer
 * @param patch - Partial style update
 * @param opacity - Master opacity multiplied into opacity properties
 * @returns The list of paint operations to apply
 */
export function stylePatchToPaintOps(
  info: Pick<VectorLayerInfo, 'id' | 'layerIds'>,
  patch: Partial<VectorLayerStyle>,
  opacity = 1,
): PaintOp[] {
  const master = clampOpacity(opacity);
  const ops: PaintOp[] = [];
  const has = (suffix: LayerSuffix) => info.layerIds.includes(mapLayerId(info.id, suffix));
  const push = (suffix: LayerSuffix, property: string, value: PaintValue | undefined) => {
    if (value !== undefined && has(suffix)) {
      ops.push({ layerId: mapLayerId(info.id, suffix), property, value });
    }
  };

  // A data-driven color expression in the patch overrides the flat color.
  const fillColor = patch.fillColorExpression ?? patch.fillColor;
  const lineColor = patch.lineColorExpression ?? patch.lineColor;
  const circleColor = patch.circleColorExpression ?? patch.circleColor;

  push('fill', 'fill-color', fillColor);
  push('fill', 'fill-opacity', patch.fillOpacity === undefined ? undefined : patch.fillOpacity * master);
  push('outline', 'line-color', lineColor);
  push('outline', 'line-width', patch.lineWidth);
  push('line', 'line-color', lineColor);
  push('line', 'line-width', patch.lineWidth);
  push('circle', 'circle-color', circleColor);
  push('circle', 'circle-radius', patch.circleRadius);
  push('circle', 'circle-opacity', patch.circleOpacity === undefined ? undefined : patch.circleOpacity * master);
  // Heatmap radius/intensity are plain paint updates (no rebuild needed); the
  // cluster bubble tracks the circle color and opacity. pointMode and cluster
  // radius/maxZoom changes are structural and handled by the layer manager.
  push('heatmap', 'heatmap-radius', patch.heatmapRadius);
  push('heatmap', 'heatmap-intensity', patch.heatmapIntensity);
  push('cluster', 'circle-color', circleColor);
  push('cluster', 'circle-opacity', patch.circleOpacity === undefined ? undefined : patch.circleOpacity * master);
  // Label paint. text-size, placement, and the text-field itself are layout
  // (not paint) and are applied by the layer manager, which also adds or
  // removes the label layer when the labelField is set or cleared.
  push('label', 'text-color', patch.labelColor);
  push('label', 'text-halo-color', patch.labelHaloColor);
  push(
    'label',
    'text-halo-width',
    patch.labelHaloWidth === undefined ? undefined : Math.max(0, patch.labelHaloWidth),
  );

  return ops;
}

/**
 * Maps a master opacity change to the setPaintProperty operations it
 * implies, multiplying the style's own opacities where applicable.
 *
 * @param info - The vector layer
 * @param style - The layer's current style
 * @param opacity - The new master opacity (0-1)
 * @returns The list of paint operations to apply
 */
export function opacityToPaintOps(
  info: Pick<VectorLayerInfo, 'id' | 'layerIds'>,
  style: VectorLayerStyle,
  opacity: number,
): PaintOp[] {
  const master = clampOpacity(opacity);
  const ops: PaintOp[] = [];
  const has = (suffix: LayerSuffix) => info.layerIds.includes(mapLayerId(info.id, suffix));
  const push = (suffix: LayerSuffix, property: string, value: string | number) => {
    if (has(suffix)) {
      ops.push({ layerId: mapLayerId(info.id, suffix), property, value });
    }
  };

  push('fill', 'fill-opacity', style.fillOpacity * master);
  push('outline', 'line-opacity', master);
  push('line', 'line-opacity', master);
  push('circle', 'circle-opacity', style.circleOpacity * master);
  push('circle', 'circle-stroke-opacity', master);
  push('heatmap', 'heatmap-opacity', master);
  push('cluster', 'circle-opacity', style.circleOpacity * master);
  push('cluster', 'circle-stroke-opacity', master);
  push('cluster-count', 'text-opacity', master);
  push('label', 'text-opacity', master);

  return ops;
}

/**
 * Applies a style patch to the map layers of a vector layer.
 *
 * @param map - The MapLibre map
 * @param info - The vector layer
 * @param patch - Partial style update
 * @param opacity - Master opacity multiplied into opacity properties
 */
export function applyStyle(
  map: MapLibreMap,
  info: Pick<VectorLayerInfo, 'id' | 'layerIds'>,
  patch: Partial<VectorLayerStyle>,
  opacity = 1,
): void {
  for (const op of stylePatchToPaintOps(info, patch, opacity)) {
    map.setPaintProperty(op.layerId, op.property, op.value);
  }
}

/**
 * Applies a master opacity change to the map layers of a vector layer.
 *
 * @param map - The MapLibre map
 * @param info - The vector layer
 * @param style - The layer's current style
 * @param opacity - The new master opacity (0-1)
 */
export function applyOpacity(
  map: MapLibreMap,
  info: Pick<VectorLayerInfo, 'id' | 'layerIds'>,
  style: VectorLayerStyle,
  opacity: number,
): void {
  for (const op of opacityToPaintOps(info, style, opacity)) {
    map.setPaintProperty(op.layerId, op.property, op.value);
  }
}
