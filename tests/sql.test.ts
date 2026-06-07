import { describe, it, expect } from 'vitest';
import {
  TILE_FEATURE_LIMIT,
  bboxSummaryQuery,
  createViewSql,
  isBboxCoveringColumn,
  mvtTileStreamQuery,
  sampledGeometryTypesQuery,
  createTableFromLonLatSql,
  createTableFromWktSql,
  createTableSql,
  exportGeoJSONQuery,
  gdalPath,
  mvtProbeQuery,
  mvtTileQuery,
  prepareTilesSql,
  quoteIdent,
  quoteLiteral,
  readerFor,
  summaryQuery,
  tileFeaturesQuery,
} from '../src/lib/engine/sql';

describe('quoting', () => {
  it('quotes identifiers', () => {
    expect(quoteIdent('my col')).toBe('"my col"');
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
  });

  it('quotes literals', () => {
    expect(quoteLiteral("it's")).toBe("'it''s'");
  });
});

describe('readerFor', () => {
  it('uses read_parquet for GeoParquet', () => {
    expect(readerFor('geoparquet', 'data.parquet')).toBe("read_parquet('data.parquet')");
  });

  it('uses read_csv for CSV', () => {
    expect(readerFor('csv', 'data.csv')).toBe("read_csv('data.csv')");
  });

  it('uses ST_Read for spatial formats', () => {
    expect(readerFor('geopackage', 'data.gpkg')).toBe("ST_Read('data.gpkg')");
    expect(readerFor('flatgeobuf', 'data.fgb')).toBe("ST_Read('data.fgb')");
  });

  it('passes the layer to ST_Read', () => {
    expect(readerFor('geopackage', 'data.gpkg', 'roads')).toBe(
      "ST_Read('data.gpkg', layer = 'roads')",
    );
  });
});

describe('gdalPath', () => {
  it('wraps local zip archives in /vsizip/', () => {
    expect(gdalPath('shapefile', 'data.zip')).toBe('/vsizip/data.zip');
  });

  it('wraps remote zip archives in /vsizip//vsicurl/', () => {
    expect(gdalPath('shapefile', 'https://x.com/data.zip')).toBe(
      '/vsizip//vsicurl/https://x.com/data.zip',
    );
  });

  it('leaves non-zip paths alone', () => {
    expect(gdalPath('shapefile', 'data.shp')).toBe('data.shp');
    expect(gdalPath('geopackage', 'data.gpkg')).toBe('data.gpkg');
  });
});

describe('createTableSql', () => {
  it('renames the geometry column to geom', () => {
    const sql = createTableSql('t1', "ST_Read('f.gpkg')", 'geometry');
    expect(sql).toBe(
      'CREATE OR REPLACE TABLE "t1" AS SELECT * RENAME ("geometry" AS geom) FROM ST_Read(\'f.gpkg\')',
    );
  });

  it('skips the rename when the column is already geom', () => {
    const sql = createTableSql('t1', "ST_Read('f.gpkg')", 'geom');
    expect(sql).toBe('CREATE OR REPLACE TABLE "t1" AS SELECT * FROM ST_Read(\'f.gpkg\')');
  });
});

describe('CSV table creation', () => {
  it('builds geometry from a WKT column', () => {
    const sql = createTableFromWktSql('t1', "read_csv('f.csv')", 'wkt');
    expect(sql).toContain('ST_GeomFromText("wkt") AS geom');
    expect(sql).toContain('EXCLUDE ("wkt")');
  });

  it('builds geometry from lon/lat columns', () => {
    const sql = createTableFromLonLatSql('t1', "read_csv('f.csv')", 'lon', 'lat');
    expect(sql).toContain('ST_Point("lon", "lat") AS geom');
  });
});

describe('summaryQuery', () => {
  it('computes count and extent', () => {
    const sql = summaryQuery('t1');
    expect(sql).toContain('count(*)');
    expect(sql).toContain('ST_XMin(ST_Extent_Agg(geom))');
    expect(sql).toContain('ST_YMin(ST_Extent_Agg(geom))');
    expect(sql).toContain('ST_XMax(ST_Extent_Agg(geom))');
    expect(sql).toContain('ST_YMax(ST_Extent_Agg(geom))');
  });
});

describe('exportGeoJSONQuery', () => {
  it('selects geometry as GeoJSON plus properties', () => {
    const sql = exportGeoJSONQuery('t1', ['name', 'pop']);
    expect(sql).toBe(
      'SELECT ST_AsGeoJSON(geom) AS __geojson, "name", "pop" FROM "t1" WHERE geom IS NOT NULL',
    );
  });

  it('works without properties', () => {
    expect(exportGeoJSONQuery('t1', [])).toBe(
      'SELECT ST_AsGeoJSON(geom) AS __geojson FROM "t1" WHERE geom IS NOT NULL',
    );
  });
});

describe('prepareTilesSql', () => {
  it('adds a transformed column and an R-Tree index', () => {
    const { transform, index } = prepareTilesSql('t1');
    expect(transform[0]).toContain('ADD COLUMN IF NOT EXISTS geom_3857');
    expect(transform[1]).toContain("ST_Transform(geom, 'EPSG:4326', 'EPSG:3857', always_xy := true)");
    expect(index).toContain('USING RTREE (geom_3857)');
  });
});

describe('mvtTileQuery', () => {
  it('builds the ST_AsMVT query for a tile', () => {
    const sql = mvtTileQuery('t1', 'mylayer', 3, 2, 1, ['name']);
    expect(sql).toContain('ST_AsMVT(');
    expect(sql).toContain('ST_AsMVTGeom(geom_3857, ST_Extent(ST_TileEnvelope(3, 2, 1)))');
    expect(sql).toContain("'name': TRY_CAST(\"name\" AS VARCHAR)");
    expect(sql).toContain("'mylayer'");
    expect(sql).toContain('ST_Intersects(geom_3857, ST_TileEnvelope(3, 2, 1))');
    expect(sql).toContain(`LIMIT ${TILE_FEATURE_LIMIT}`);
  });
});

describe('tileFeaturesQuery', () => {
  it('filters by the tile envelope in EPSG:4326', () => {
    const sql = tileFeaturesQuery('t1', [-10, -20, 30, 40], ['name']);
    expect(sql).toContain('ST_MakeEnvelope(-10, -20, 30, 40)');
    expect(sql).toContain('ST_AsGeoJSON(geom)');
    expect(sql).toContain('"name"');
  });
});

describe('streaming ingest SQL', () => {
  it('creates a view with the geometry column normalized', () => {
    expect(createViewSql('t1', "read_parquet('f.parquet')", 'geometry')).toBe(
      'CREATE OR REPLACE VIEW "t1" AS SELECT * RENAME ("geometry" AS geom) FROM read_parquet(\'f.parquet\')',
    );
  });

  it('recognizes bbox covering columns by common names', () => {
    const structType = 'STRUCT(xmin FLOAT, ymin FLOAT, xmax FLOAT, ymax FLOAT)';
    expect(isBboxCoveringColumn('bbox', structType)).toBe(true);
    expect(isBboxCoveringColumn('geometry_bbox', structType)).toBe(true);
    expect(isBboxCoveringColumn('geom_bbox', structType)).toBe(true);
    expect(isBboxCoveringColumn('BBOX', structType)).toBe(true);
    expect(isBboxCoveringColumn('bbox', 'VARCHAR')).toBe(false);
    expect(isBboxCoveringColumn('bbox', 'STRUCT(xmin FLOAT, ymax FLOAT)')).toBe(false);
    expect(isBboxCoveringColumn('extent', structType)).toBe(false);
    expect(isBboxCoveringColumn('boundingbox', structType)).toBe(false);
  });

  it('summarizes from the bbox covering column without a geometry scan', () => {
    const sql = bboxSummaryQuery('t1', 'geometry_bbox');
    expect(sql).toContain('min("geometry_bbox".xmin)');
    expect(sql).toContain('max("geometry_bbox".ymax)');
    expect(sql).not.toContain('ST_Extent_Agg');
  });

  it('samples geometry types instead of scanning every row', () => {
    const sql = sampledGeometryTypesQuery('t1', 50);
    expect(sql).toContain('LIMIT 50');
    expect(sql).toContain('ST_GeometryType');
  });

  it('builds the streaming tile query with bbox pushdown and per-tile transform', () => {
    const sql = mvtTileStreamQuery('t1', 'layer', 3, 2, 1, [-10, -20, 30, 40], ['name'], 'bbox');
    expect(sql).toContain("ST_Transform(geom, 'EPSG:4326', 'EPSG:3857', always_xy := true)");
    expect(sql).toContain('"bbox".xmin <= 30 AND "bbox".xmax >= -10');
    expect(sql).toContain('"bbox".ymin <= 40 AND "bbox".ymax >= -20');
    expect(sql).toContain('ST_Intersects(geom, ST_MakeEnvelope(-10, -20, 30, 40))');
    expect(sql).toContain('ST_TileEnvelope(3, 2, 1)');
    expect(sql).toContain(`LIMIT ${TILE_FEATURE_LIMIT}`);
  });

  it('omits the pushdown filter without a bbox column', () => {
    const sql = mvtTileStreamQuery('t1', 'layer', 3, 2, 1, [-10, -20, 30, 40], []);
    expect(sql).not.toContain('.xmin <=');
    expect(sql).toContain('ST_Intersects(geom,');
  });
});

describe('mvtProbeQuery', () => {
  it('exercises ST_AsMVT, ST_AsMVTGeom, and ST_TileEnvelope', () => {
    const sql = mvtProbeQuery();
    expect(sql).toContain('ST_AsMVT(');
    expect(sql).toContain('ST_AsMVTGeom(');
    expect(sql).toContain('ST_TileEnvelope(0, 0, 0)');
  });
});
