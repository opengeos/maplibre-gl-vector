import type { Map as MapLibreMap } from 'maplibre-gl';
import type { Bbox } from './geometry';

/**
 * Globe-safe camera fitting.
 *
 * `map.fitBounds` is unreliable under the globe projection once an extent
 * grows past roughly a third of the planet: instead of continuing to pull
 * back, MapLibre's globe camera solver starts zooming *in* again. Measured on
 * a 576x648 viewport with 40px padding, a bbox 150 degrees wide settles at
 * zoom 1.97, one 259 degrees wide at 3.10, and one 359 degrees wide at 5.00 —
 * a near-global dataset ends up framed on an empty patch of ocean with every
 * feature behind the horizon. The flat-map answers for the same boxes are
 * 1.22, 0.43 and 0.00.
 *
 * A dataset with a few far-flung outliers (a mostly-US point layer with three
 * records in Europe and Asia, say) hits this immediately, and the layer reads
 * as "added but invisible".
 *
 * So the flat-map fit is computed here and handed to `fitBounds` as a zoom
 * ceiling. It only ever loosens the camera: the globe shows less of the world
 * than Web Mercator does at the same zoom, and MapLibre's own solver already
 * pulls back further than this for bearing and pitch. A sane fit is left
 * alone; a broken one is capped at a whole-globe view.
 */

/**
 * The latitude at which Web Mercator is truncated; the projection runs to
 * infinity at the poles.
 */
const MAX_MERCATOR_LATITUDE = 85.051129;

/** The tile size MapLibre's zoom scale is defined against. */
const TILE_SIZE = 512;

/** Normalized (0..1) Web Mercator northing for a latitude in degrees. */
function mercatorY(latitude: number): number {
  const clamped = Math.min(MAX_MERCATOR_LATITUDE, Math.max(-MAX_MERCATOR_LATITUDE, latitude));
  return 0.5 - Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360)) / (2 * Math.PI);
}

/**
 * Computes the zoom at which a bbox fits a viewport under flat Web Mercator.
 *
 * @param bbox - The extent to fit, as [west, south, east, north] in EPSG:4326
 * @param viewport - The map viewport size in CSS pixels
 * @param padding - Padding to keep free on every side, in CSS pixels
 * @returns The fitting zoom, or undefined when the inputs cannot produce one
 *   (an unmeasurable viewport, or an extent with no width and no height)
 */
export function mercatorFitZoom(
  bbox: Bbox,
  viewport: { width: number; height: number },
  padding: number,
): number | undefined {
  if (!bbox.every((value) => Number.isFinite(value))) return undefined;
  const [west, south, east, north] = bbox;
  const usableWidth = viewport.width - 2 * padding;
  const usableHeight = viewport.height - 2 * padding;
  if (!(usableWidth > 0) || !(usableHeight > 0)) return undefined;

  // Either span may be zero (a point layer, or a horizontal line); such an
  // axis simply places no constraint on the zoom.
  const worldFractionX = Math.abs(east - west) / 360;
  const worldFractionY = Math.abs(mercatorY(south) - mercatorY(north));

  const scales: number[] = [];
  if (worldFractionX > 0) scales.push(usableWidth / (TILE_SIZE * worldFractionX));
  if (worldFractionY > 0) scales.push(usableHeight / (TILE_SIZE * worldFractionY));
  if (scales.length === 0) return undefined;

  const zoom = Math.log2(Math.min(...scales));
  return Number.isFinite(zoom) ? zoom : undefined;
}

/** The camera options {@link fitMapToBbox} forwards to `map.fitBounds`. */
export interface FitBboxOptions {
  /** Padding to keep free on every side, in CSS pixels. */
  padding: number;
  /** Animation length in milliseconds. */
  duration?: number;
  /** The closest zoom the fit may settle on, before the flat-map ceiling. */
  maxZoom?: number;
}

/**
 * Reads the map's viewport in CSS pixels, when it can be measured. A canvas
 * that has never been laid out (jsdom, a detached container) reports zero and
 * yields undefined, so the caller skips the ceiling rather than computing one
 * from a bogus size.
 */
function viewportOf(map: MapLibreMap): { width: number; height: number } | undefined {
  const canvas = typeof map.getCanvas === 'function' ? map.getCanvas() : undefined;
  const width = canvas?.clientWidth ?? 0;
  const height = canvas?.clientHeight ?? 0;
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/**
 * Fits the map to a bbox, capping the zoom at the flat-map fit so a wide
 * extent cannot be framed on empty space by the globe camera.
 *
 * @param map - The map to move
 * @param bbox - The extent to fit, as [west, south, east, north] in EPSG:4326
 * @param options - Padding, animation length, and an optional zoom ceiling
 */
export function fitMapToBbox(map: MapLibreMap, bbox: Bbox, options: FitBboxOptions): void {
  const viewport = viewportOf(map);
  const flatZoom = viewport ? mercatorFitZoom(bbox, viewport, options.padding) : undefined;
  const maxZoom =
    flatZoom === undefined
      ? options.maxZoom
      : Math.min(flatZoom, options.maxZoom ?? Number.POSITIVE_INFINITY);

  map.fitBounds(
    [
      [bbox[0], bbox[1]],
      [bbox[2], bbox[3]],
    ],
    {
      padding: options.padding,
      ...(options.duration === undefined ? {} : { duration: options.duration }),
      ...(maxZoom === undefined ? {} : { maxZoom }),
    },
  );
}
