import { beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';
import {
  ensureGpkgFeatureCountSync,
  looksLikeSqlite,
} from '../src/lib/engine/gpkgOgrContents';

const require = createRequire(import.meta.url);

// sql.js types are not depended on at runtime (it is loaded from a CDN); the
// test initialises the dev-dependency copy directly.
/* eslint-disable @typescript-eslint/no-explicit-any */
let SQL: any;

beforeAll(async () => {
  const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
  SQL = await (initSqlJs as any)({ locateFile: () => wasmPath });
});

function buildGpkg(options: {
  withOgrContents?: boolean;
  featureCount?: number;
  tableName?: string;
}): Uint8Array {
  const tableName = options.tableName ?? 'places';
  const featureCount = options.featureCount ?? 3;
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE gpkg_contents (
      table_name TEXT NOT NULL PRIMARY KEY,
      data_type TEXT NOT NULL,
      srs_id INTEGER
    );
    CREATE TABLE "${tableName}" (fid INTEGER PRIMARY KEY, geom BLOB, name TEXT);
  `);
  db.run(
    "INSERT INTO gpkg_contents (table_name, data_type, srs_id) VALUES (:t, 'features', 4326)",
    { ':t': tableName },
  );
  for (let i = 0; i < featureCount; i += 1) {
    db.run(`INSERT INTO "${tableName}" (name) VALUES (:n)`, { ':n': `f-${i}` });
  }
  if (options.withOgrContents) {
    db.run(
      'CREATE TABLE gpkg_ogr_contents (table_name TEXT NOT NULL PRIMARY KEY, feature_count INTEGER)',
    );
    db.run(
      'INSERT INTO gpkg_ogr_contents (table_name, feature_count) VALUES (:t, :c)',
      { ':t': tableName, ':c': featureCount },
    );
  }
  const bytes = db.export() as Uint8Array;
  db.close();
  return bytes;
}

function readOgrContents(
  bytes: Uint8Array,
): Array<{ table_name: string; feature_count: number }> {
  const db = new SQL.Database(bytes);
  try {
    const result = db.exec(
      'SELECT table_name, feature_count FROM gpkg_ogr_contents ORDER BY table_name',
    );
    if (result.length === 0) return [];
    return result[0].values.map((row: Array<unknown>) => ({
      table_name: row[0] as string,
      feature_count: row[1] as number,
    }));
  } finally {
    db.close();
  }
}

describe('looksLikeSqlite', () => {
  it('detects the SQLite magic header', () => {
    expect(looksLikeSqlite(buildGpkg({}))).toBe(true);
  });

  it('rejects non-SQLite buffers', () => {
    expect(looksLikeSqlite(new Uint8Array([1, 2, 3, 4]))).toBe(false);
    expect(looksLikeSqlite(new TextEncoder().encode('not a db'))).toBe(false);
  });
});

describe('ensureGpkgFeatureCountSync', () => {
  it('injects gpkg_ogr_contents when missing', () => {
    const original = buildGpkg({ withOgrContents: false, featureCount: 5 });
    const patched = ensureGpkgFeatureCountSync(SQL, original);

    expect(patched).not.toBe(original);
    expect(readOgrContents(patched)).toEqual([
      { table_name: 'places', feature_count: 5 },
    ]);
  });

  it('adds a row for every feature table', () => {
    const db = new SQL.Database();
    db.run(`
      CREATE TABLE gpkg_contents (
        table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL, srs_id INTEGER
      );
      CREATE TABLE roads (fid INTEGER PRIMARY KEY, geom BLOB);
      CREATE TABLE rivers (fid INTEGER PRIMARY KEY, geom BLOB);
      INSERT INTO gpkg_contents VALUES ('roads', 'features', 4326);
      INSERT INTO gpkg_contents VALUES ('rivers', 'features', 4326);
      INSERT INTO roads (geom) VALUES (NULL), (NULL);
      INSERT INTO rivers (geom) VALUES (NULL), (NULL), (NULL), (NULL);
    `);
    const original = db.export() as Uint8Array;
    db.close();

    const patched = ensureGpkgFeatureCountSync(SQL, original);
    expect(readOgrContents(patched)).toEqual([
      { table_name: 'rivers', feature_count: 4 },
      { table_name: 'roads', feature_count: 2 },
    ]);
  });

  it('leaves a complete GeoPackage untouched', () => {
    const original = buildGpkg({ withOgrContents: true, featureCount: 3 });
    expect(ensureGpkgFeatureCountSync(SQL, original)).toBe(original);
  });

  it('ignores SQLite databases that are not GeoPackages', () => {
    const db = new SQL.Database();
    db.run('CREATE TABLE notes (id INTEGER); INSERT INTO notes VALUES (1);');
    const original = db.export() as Uint8Array;
    db.close();

    expect(ensureGpkgFeatureCountSync(SQL, original)).toBe(original);
  });
});
