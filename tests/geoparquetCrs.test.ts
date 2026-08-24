import { describe, it, expect } from 'vitest';
import { geoParquetSourceCrs } from '../src/lib/formats/geoparquetCrs';
import {
  GEOPARQUET_METADATA_COLUMN,
  GEOPARQUET_METADATA_KEY,
  geoParquetCrsQuery,
} from '../src/lib/engine/sql';

/** The engine's own WGS84 test, mirrored so the parser is exercised as it is used. */
const isWgs84 = (crs: string) =>
  ['EPSG:4326', 'EPSG:4979', 'OGC:CRS84'].includes(crs.toUpperCase());

/** A `geo` document shaped the way GeoPandas/GDAL write one. */
function geoMetadata(
  crs: unknown,
  options: { column?: string; omitCrs?: boolean } = {},
): string {
  const column = options.column ?? 'geometry';
  const entry: Record<string, unknown> = { encoding: 'WKB' };
  if (!options.omitCrs) entry.crs = crs;
  return JSON.stringify({
    version: '1.0.0',
    primary_column: column,
    columns: { [column]: entry },
  });
}

/** The PROJJSON GeoPandas writes for GGRS87 / Greek Grid, trimmed to what is read. */
const GREEK_GRID_PROJJSON = {
  type: 'ProjectedCRS',
  name: 'GGRS87 / Greek Grid',
  base_crs: { name: 'GGRS87', id: { authority: 'EPSG', code: 4121 } },
  id: { authority: 'EPSG', code: 2100 },
};

describe('geoParquetCrsQuery', () => {
  it('reads the `geo` key of the named file as text', () => {
    const sql = geoParquetCrsQuery('greece.parquet');
    expect(sql).toContain("parquet_kv_metadata('greece.parquet')");
    expect(sql).toContain(`decode(value) AS ${GEOPARQUET_METADATA_COLUMN}`);
    // The key is compared as a BLOB rather than decoded, so a file carrying a
    // non-UTF-8 metadata key cannot fail the read.
    expect(sql).toContain(`key = encode('${GEOPARQUET_METADATA_KEY}')`);
    expect(sql).not.toContain('decode(key)');
  });

  it('escapes a quote in the path', () => {
    expect(geoParquetCrsQuery("o'brien.parquet")).toContain(
      "parquet_kv_metadata('o''brien.parquet')",
    );
  });
});

describe('geoParquetSourceCrs', () => {
  it('returns the EPSG identity of a projected CRS', () => {
    expect(geoParquetSourceCrs(geoMetadata(GREEK_GRID_PROJJSON), isWgs84)).toBe(
      'EPSG:2100',
    );
  });

  it("prefers the CRS's own id over its base CRS", () => {
    // The base_crs of EPSG:2100 is EPSG:4121, a geographic system: reading that
    // one instead would leave the metre coordinates untransformed.
    expect(
      geoParquetSourceCrs(geoMetadata(GREEK_GRID_PROJJSON), isWgs84),
    ).not.toBe('EPSG:4121');
  });

  it('skips reprojection for WGS84 identities', () => {
    for (const id of [
      { authority: 'EPSG', code: 4326 },
      { authority: 'EPSG', code: 4979 },
      { authority: 'OGC', code: 'CRS84' },
    ]) {
      expect(geoParquetSourceCrs(geoMetadata({ id }), isWgs84)).toBeNull();
    }
  });

  it('skips reprojection for an absent crs member (the spec default is CRS84)', () => {
    expect(
      geoParquetSourceCrs(geoMetadata(null, { omitCrs: true }), isWgs84),
    ).toBeNull();
  });

  it('skips reprojection for an explicit null crs (no known CRS)', () => {
    expect(geoParquetSourceCrs(geoMetadata(null), isWgs84)).toBeNull();
  });

  it('hands PROJ the whole PROJJSON when the CRS has no authority code', () => {
    const custom = { type: 'ProjectedCRS', name: 'Custom Site Grid' };
    expect(geoParquetSourceCrs(geoMetadata(custom), isWgs84)).toBe(
      JSON.stringify(custom),
    );
  });

  it('accepts the WKT string the pre-1.0 drafts wrote', () => {
    const wkt = 'PROJCS["Greek_Grid",GEOGCS["GCS_GGRS_1987"]]';
    expect(geoParquetSourceCrs(geoMetadata(wkt), isWgs84)).toBe(wkt);
    expect(geoParquetSourceCrs(geoMetadata('EPSG:4326'), isWgs84)).toBeNull();
  });

  it('reads the column named by primary_column, not the first one listed', () => {
    const metadata = JSON.stringify({
      primary_column: 'geom_2100',
      columns: {
        geom_4326: { crs: { id: { authority: 'EPSG', code: 4326 } } },
        geom_2100: { crs: GREEK_GRID_PROJJSON },
      },
    });
    expect(geoParquetSourceCrs(metadata, isWgs84)).toBe('EPSG:2100');
  });

  it('falls back to the only column when primary_column names none', () => {
    const metadata = JSON.stringify({
      primary_column: 'missing',
      columns: { geometry: { crs: GREEK_GRID_PROJJSON } },
    });
    expect(geoParquetSourceCrs(metadata, isWgs84)).toBe('EPSG:2100');
  });

  it('returns null for a plain Parquet with no metadata, or an unreadable one', () => {
    for (const value of [null, undefined, '', 'not json', '{}']) {
      expect(geoParquetSourceCrs(value, isWgs84)).toBeNull();
    }
    expect(
      geoParquetSourceCrs(JSON.stringify({ columns: {} }), isWgs84),
    ).toBeNull();
  });
});
