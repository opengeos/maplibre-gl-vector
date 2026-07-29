import type { Map as MapLibreMap } from 'maplibre-gl';
import type { Bbox } from './geometry';

/**
 * Globe-safe camera fitting.
 *
 * A globe can only ever show half the planet's longitudes at once, so an extent
 * wider than a hemisphere has no camera that contains it. MapLibre's
 * `fitBounds` does not treat that as the special case it is: past roughly a
 * hemisphere its globe camera solver stops pulling back and starts zooming *in*
 * again. Measured against a live map on a 576x648 viewport with 40px padding,
 * sampling the box outline to see how much of it lands inside the padded
 * viewport:
 *
 * | bbox width | globe zoom | outline in frame | flat-map zoom |
 * | ---------- | ---------- | ---------------- | ------------- |
 * | 90 deg     | 2.27       | 42/42            | 1.95          |
 * | 150 deg    | 1.97       | 42/42            | 1.22          |
 * | 170 deg    | 2.00       | 42/42            | 1.07          |
 * | 175 deg    | 2.01       | 34/42            | 1.03          |
 * | 259 deg    | 3.10       | 10/42            | 0.43          |
 * | 360 deg    | 2.36       | 46/84            | 0.00          |
 *
 * So MapLibre frames narrow and continent-scale extents correctly and only
 * breaks down past a hemisphere, where it leaves the data behind the horizon
 * and the layer reads as "added, but nothing on the map". It takes very little
 * to get there: a mostly-US point layer with three records in Europe and Asia
 * already spans 259 degrees.
 *
 * {@link fitMapToBbox} therefore caps the zoom at the flat Web Mercator fit for
 * exactly those extents, so the camera settles on a whole-globe view instead.
 * Fits MapLibre already handles are passed through untouched. The cap is a
 * ceiling and never a floor, so it cannot tighten a fit; and under the mercator
 * projection it equals what `fitBounds` computes anyway, making it a no-op
 * there.
 */

/**
 * The latitude at which Web Mercator is truncated; the projection runs to
 * infinity at the poles.
 */
const MAX_MERCATOR_LATITUDE = 85.051129;

/** The tile size MapLibre's zoom scale is defined against. */
const TILE_SIZE = 512;

/**
 * The widest longitude span a globe can show at once: half the planet. Past
 * this, no camera contains the extent and MapLibre's globe fit degrades (see
 * the measurements above), so the flat-map ceiling takes over. The measured
 * boundary sits a little under this (containment ends around 175 degrees on a
 * 576x648 viewport, since the padding eats into the visible hemisphere), but
 * the geometric limit is used rather than a viewport-tuned constant: extents in
 * that narrow band keep MapLibre's own fit, which puts only their extreme
 * east/west edges just outside the padding.
 */
const GLOBE_VISIBLE_LONGITUDE_SPAN = 180;

/** Normalized (0..1) Web Mercator northing for a latitude in degrees. */
function mercatorY(latitude: number): number {
  const clamped = Math.min(MAX_MERCATOR_LATITUDE, Math.max(-MAX_MERCATOR_LATITUDE, latitude));
  return 0.5 - Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360)) / (2 * Math.PI);
}

/**
 * The longitude span of a bbox in degrees, taking the short way round so an
 * extent crossing the antimeridian (`west` greater than `east`, e.g.
 * `[170, …, -170, …]`) reads as the ~20 degrees it covers rather than the ~340
 * degree complement. A full-world box (`[-180, …, 180, …]`) still reads as 360.
 *
 * @param west - The bbox's western edge in degrees
 * @param east - The bbox's eastern edge in degrees
 * @returns The span in degrees, in [0, 360]
 */
export function longitudeSpan(west: number, east: number): number {
  const span = east - west;
  if (span >= 360) return 360;
  return ((span % 360) + 360) % 360;
}

/**
 * Computes the zoom at which a bbox fits a viewport under flat Web Mercator.
 *
 * @param bbox - The extent to fit, as [west, south, east, north] in EPSG:4326.
 *   A `west` greater than `east` is read as crossing the antimeridian.
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
  const worldFractionX = longitudeSpan(west, east) / 360;
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
 * The zoom ceiling to send with a fit: the caller's own, tightened to the
 * flat-map fit for an extent too wide for any globe camera to contain.
 */
function ceilingFor(
  map: MapLibreMap,
  bbox: Bbox,
  options: FitBboxOptions,
): number | undefined {
  const [west, , east] = bbox;
  const fitsOnAGlobe =
    !Number.isFinite(west) ||
    !Number.isFinite(east) ||
    longitudeSpan(west, east) <= GLOBE_VISIBLE_LONGITUDE_SPAN;
  if (fitsOnAGlobe) return options.maxZoom;

  const viewport = viewportOf(map);
  const flatZoom = viewport ? mercatorFitZoom(bbox, viewport, options.padding) : undefined;
  if (flatZoom === undefined) return options.maxZoom;
  return Math.min(flatZoom, options.maxZoom ?? Number.POSITIVE_INFINITY);
}

/**
 * Fits the map to a bbox, capping the zoom at the flat-map fit when the extent
 * is wider than a globe can show, so it cannot be framed on empty space.
 *
 * @param map - The map to move
 * @param bbox - The extent to fit, as [west, south, east, north] in EPSG:4326
 * @param options - Padding, animation length, and an optional zoom ceiling
 */
export function fitMapToBbox(map: MapLibreMap, bbox: Bbox, options: FitBboxOptions): void {
  const maxZoom = ceilingFor(map, bbox, options);

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
