/**
 * Antimeridian-aware extents for camera fitting.
 *
 * A plain min/max over longitudes reads a layer with features at 179 and -179
 * degrees as spanning 358 degrees, so fitting the camera to it frames the whole
 * globe instead of the narrow band it really covers (Alaska's Aleutians, Fiji,
 * a run of Pacific earthquakes). The helpers here take the short way round
 * instead: the longitude extent is the circle minus its widest stretch with no
 * data in it.
 *
 * Results use the unwrapped form MapLibre's own `getBounds()` reports: `west`
 * in [-180, 180] and `west <= east` always, with an extent that crosses the
 * antimeridian carrying `east > 180` rather than inverting the pair. MapLibre's
 * `fitBounds` frames such a box across the antimeridian directly.
 */

import type { Geometry, Position } from 'geojson';
import type { Bbox } from './geometry';

/**
 * A longitude extent no wider than this cannot be narrowed by wrapping: the
 * gap across the antimeridian is then at least as wide as any other gap.
 */
export const HEMISPHERE_DEGREES = 180;

/**
 * The shortest longitude arc covering every interval, as `[west, east]`.
 *
 * Each interval is a `[min, max]` pair of longitudes in degrees (a point is
 * `[x, x]`). One whose `max` exceeds 180 is read as already crossing the
 * antimeridian, and an RFC 7946 pair with `min > max` is read the same way. An
 * interval 360 degrees or wider covers the whole circle.
 *
 * The arc is the complement of the widest gap between the intervals. When the
 * gap that contains the antimeridian is at least as wide as any other, the
 * answer is the plain `[min, max]`, so data that does not benefit from wrapping
 * keeps exactly the extent it always had.
 *
 * @param intervals - Longitude intervals in degrees
 * @returns `[west, east]` with `west <= east` and `east` possibly above 180,
 *   or null when no interval has finite bounds
 */
export function shortestLongitudeExtent(
  intervals: Iterable<readonly [number, number]>,
): [number, number] | null {
  const pieces: Array<[number, number]> = [];
  let plainMin = Number.POSITIVE_INFINITY;
  let plainMax = Number.NEGATIVE_INFINITY;
  let simple = true;
  for (const [rawMin, rawMax] of intervals) {
    if (!Number.isFinite(rawMin) || !Number.isFinite(rawMax)) continue;
    const min = rawMin;
    const max = rawMax < rawMin ? rawMax + 360 : rawMax;
    if (max - min >= 360) return [-180, 180];
    if (min < plainMin) plainMin = min;
    if (max > plainMax) plainMax = max;
    if (min < -180 || max > 180) simple = false;
    pieces.push([min, max]);
  }
  if (pieces.length === 0) return null;
  // Gaps sum to 360 minus the covered length, so when the plain extent is at
  // most a hemisphere the gap across the antimeridian is the widest one and the
  // plain extent is already the answer. This keeps the common case sort-free.
  if (simple && plainMax - plainMin <= HEMISPHERE_DEGREES) return [plainMin, plainMax];

  // Bring every interval onto the circle [-180, 180), splitting one that
  // crosses the antimeridian into its two sides.
  const onCircle: Array<[number, number]> = [];
  for (const [min, max] of pieces) {
    const start = ((((min + 180) % 360) + 360) % 360) - 180;
    const end = start + (max - min);
    if (end <= 180) {
      onCircle.push([start, end]);
    } else {
      onCircle.push([start, 180], [-180, end - 360]);
    }
  }
  onCircle.sort((a, b) => a[0] - b[0]);

  const merged: Array<[number, number]> = [];
  for (const [start, end] of onCircle) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      if (end > last[1]) last[1] = end;
    } else {
      merged.push([start, end]);
    }
  }

  const first = merged[0];
  const last = merged[merged.length - 1];
  // The gap across the antimeridian, from the last interval round to the first.
  let widest = first[0] + 360 - last[1];
  let before = -1;
  for (let i = 0; i < merged.length - 1; i++) {
    const gap = merged[i + 1][0] - merged[i][1];
    if (gap > widest) {
      widest = gap;
      before = i;
    }
  }
  if (before === -1) return [first[0], last[1]];
  // The arc runs from the interval just after the widest gap round to the one
  // just before it, which sits a full turn further east.
  return [merged[before + 1][0], merged[before][1] + 360];
}

/**
 * The extent to fit the camera to for a plain bbox and the longitude intervals
 * of the data inside it: the bbox itself when it is no wider than a hemisphere,
 * otherwise its latitudes with the shortest longitude arc over the intervals.
 *
 * @param bbox - The plain min/max extent
 * @param intervals - Longitude intervals of the data's contiguous parts; only
 *   read when the bbox is wider than a hemisphere
 * @returns The fit extent, with `east` possibly above 180
 */
export function fitExtent(bbox: Bbox, intervals: () => Iterable<readonly [number, number]>): Bbox {
  if (bbox[2] - bbox[0] <= HEMISPHERE_DEGREES) return bbox;
  const lon = shortestLongitudeExtent(intervals());
  return lon ? [lon[0], bbox[1], lon[1], bbox[3]] : bbox;
}

/**
 * Longitude interval of a run of positions, or null when none is finite.
 */
function positionsInterval(positions: unknown): [number, number] | null {
  if (!Array.isArray(positions)) return null;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const position of positions as Position[]) {
    const lon = Array.isArray(position) ? position[0] : undefined;
    if (typeof lon !== 'number' || !Number.isFinite(lon)) continue;
    if (lon < min) min = lon;
    if (lon > max) max = lon;
  }
  return min === Number.POSITIVE_INFINITY ? null : [min, max];
}

/**
 * The value when it is an array, otherwise an empty one, so a malformed
 * coordinate container (`coordinates: {}`) is skipped rather than iterated.
 */
function arrayOrEmpty<T>(value: readonly T[] | null | undefined): readonly T[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Append the `[min, max]` longitude of every contiguous part of a geometry
 * (each point, each line, each polygon's outer ring) to `out`. RFC 7946 asks
 * for a geometry that crosses the antimeridian to be split into such parts, so
 * these are the pieces {@link shortestLongitudeExtent} combines.
 *
 * @param geometry - The geometry to walk; null and malformed members are skipped
 * @param out - Receives one interval per part
 */
export function collectLongitudeIntervals(
  geometry: Geometry | null | undefined,
  out: Array<[number, number]>,
): void {
  if (!geometry || typeof geometry !== 'object') return;
  const push = (positions: unknown) => {
    const interval = positionsInterval(positions);
    if (interval) out.push(interval);
  };
  switch (geometry.type) {
    case 'Point':
      push([geometry.coordinates]);
      break;
    case 'MultiPoint':
      for (const position of arrayOrEmpty(geometry.coordinates)) push([position]);
      break;
    case 'LineString':
      push(geometry.coordinates);
      break;
    case 'MultiLineString':
      for (const line of arrayOrEmpty(geometry.coordinates)) push(line);
      break;
    case 'Polygon':
      push(arrayOrEmpty(geometry.coordinates)[0]);
      break;
    case 'MultiPolygon':
      for (const polygon of arrayOrEmpty(geometry.coordinates)) {
        push(Array.isArray(polygon) ? polygon[0] : undefined);
      }
      break;
    case 'GeometryCollection':
      for (const member of arrayOrEmpty(geometry.geometries)) collectLongitudeIntervals(member, out);
      break;
    default:
      break;
  }
}
