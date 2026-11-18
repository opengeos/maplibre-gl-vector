import { describe, it, expect } from 'vitest';
import type { Geometry } from 'geojson';
import {
  collectLongitudeIntervals,
  fitExtent,
  shortestLongitudeExtent,
} from '../src/lib/utils/antimeridian';

describe('shortestLongitudeExtent', () => {
  it('keeps the plain extent of data that does not straddle the antimeridian', () => {
    expect(shortestLongitudeExtent([[-124, -120], [-80, -70]])).toEqual([-124, -70]);
  });

  it('takes the short way round for data on both sides of the antimeridian', () => {
    // Aleutian islands either side of 180 degrees plus mainland Alaska.
    expect(shortestLongitudeExtent([[172, 179.8], [-179.2, -178], [-168, -141]])).toEqual([
      172,
      219,
    ]);
  });

  it('keeps the plain extent when the widest gap is not across the antimeridian', () => {
    // The US plus Europe, wider than a hemisphere: the widest empty stretch is
    // still the Pacific, which the plain extent already leaves out.
    expect(shortestLongitudeExtent([[-124, -70], [10, 70]])).toEqual([-124, 70]);
  });

  it('reads RFC 7946 and unwrapped intervals as crossing the antimeridian', () => {
    expect(shortestLongitudeExtent([[170, -170]])).toEqual([170, 190]);
    expect(shortestLongitudeExtent([[170, 190], [-175, -160]])).toEqual([170, 200]);
  });

  it('returns the whole circle for an interval covering it', () => {
    expect(shortestLongitudeExtent([[-180, 180]])).toEqual([-180, 180]);
  });

  it('returns null when nothing is finite', () => {
    expect(shortestLongitudeExtent([])).toBeNull();
    expect(shortestLongitudeExtent([[Number.NaN, 1]])).toBeNull();
  });
});

describe('collectLongitudeIntervals', () => {
  it('yields one interval per part, outer rings only', () => {
    const geometry: Geometry = {
      type: 'GeometryCollection',
      geometries: [
        { type: 'MultiPoint', coordinates: [[1, 0], [5, 0]] },
        {
          type: 'MultiPolygon',
          coordinates: [
            [
              [[170, 50], [179, 50], [179, 52], [170, 50]],
              [[171, 50.5], [172, 50.5], [172, 51], [171, 50.5]],
            ],
            [[[-179, 51], [-178, 51], [-178, 52], [-179, 51]]],
          ],
        },
      ],
    };
    const out: Array<[number, number]> = [];
    collectLongitudeIntervals(geometry, out);
    expect(out).toEqual([[1, 1], [5, 5], [170, 179], [-179, -178]]);
  });

  it('skips null and empty geometries', () => {
    const out: Array<[number, number]> = [];
    collectLongitudeIntervals(null, out);
    collectLongitudeIntervals({ type: 'LineString', coordinates: [] }, out);
    expect(out).toEqual([]);
  });
});

describe('fitExtent', () => {
  it('returns a bbox no wider than a hemisphere untouched without reading intervals', () => {
    const bbox: [number, number, number, number] = [-10, -5, 10, 5];
    let read = false;
    expect(
      fitExtent(bbox, () => {
        read = true;
        return [];
      }),
    ).toBe(bbox);
    expect(read).toBe(false);
  });

  it('narrows a wide bbox across the antimeridian, keeping its latitudes', () => {
    expect(fitExtent([-179, 51, 179, 60], () => [[170, 179], [-179, -170]])).toEqual([
      170, 51, 190, 60,
    ]);
  });
});
