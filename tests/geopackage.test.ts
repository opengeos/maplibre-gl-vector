import { beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";
import {
  decodeWkb,
  isLikelyGeoPackage,
  listGeoPackageLayersSync,
  readGeoPackageSync,
  stripGeoPackageHeader,
} from "../src/lib/engine/geopackage";

const require = createRequire(import.meta.url);

// sql.js types are not depended on at runtime (it is loaded from a CDN); the
// test initialises the dev-dependency copy directly.
/* eslint-disable @typescript-eslint/no-explicit-any */
let SQL: any;

beforeAll(async () => {
  const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
  SQL = await (initSqlJs as any)({ locateFile: () => wasmPath });
});

/** Little-endian WKB for a 2D Point. */
function wkbPoint(x: number, y: number): Uint8Array {
  const buffer = new ArrayBuffer(21);
  const view = new DataView(buffer);
  view.setUint8(0, 1); // little-endian
  view.setUint32(1, 1, true); // type = Point
  view.setFloat64(5, x, true);
  view.setFloat64(13, y, true);
  return new Uint8Array(buffer);
}

/** Wraps WKB in a minimal GeoPackage geometry blob header (no envelope). */
function gpkgBlob(wkb: Uint8Array, srsId: number): Uint8Array {
  const header = new Uint8Array(8);
  const view = new DataView(header.buffer);
  header[0] = 0x47; // 'G'
  header[1] = 0x50; // 'P'
  header[2] = 0; // version
  header[3] = 0x01; // flags: little-endian header, no envelope
  view.setInt32(4, srsId, true);
  const blob = new Uint8Array(header.length + wkb.length);
  blob.set(header, 0);
  blob.set(wkb, header.length);
  return blob;
}

interface BuildOptions {
  srsId?: number;
  /** Register an EPSG row in gpkg_spatial_ref_sys for srsId. */
  epsgRow?: boolean;
  tableName?: string;
  /** Additional feature tables to register (name -> srsId). */
  extraTables?: Array<{ name: string; srsId: number }>;
}

function buildGpkg(options: BuildOptions = {}): Uint8Array {
  const srsId = options.srsId ?? 4326;
  const tableName = options.tableName ?? "places";
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE gpkg_contents (
      table_name TEXT NOT NULL PRIMARY KEY,
      data_type TEXT NOT NULL,
      srs_id INTEGER
    );
    CREATE TABLE gpkg_geometry_columns (
      table_name TEXT NOT NULL,
      column_name TEXT NOT NULL,
      geometry_type_name TEXT,
      srs_id INTEGER
    );
    CREATE TABLE gpkg_spatial_ref_sys (
      srs_id INTEGER NOT NULL PRIMARY KEY,
      organization TEXT,
      organization_coordsys_id INTEGER
    );
  `);

  const tables = [{ name: tableName, srsId }, ...(options.extraTables ?? [])];
  for (const [index, table] of tables.entries()) {
    db.run(
      `CREATE TABLE "${table.name}" (fid INTEGER PRIMARY KEY, geom BLOB, name TEXT)`,
    );
    db.run(
      "INSERT INTO gpkg_contents (table_name, data_type, srs_id) VALUES (:t, 'features', :s)",
      { ":t": table.name, ":s": table.srsId },
    );
    db.run(
      "INSERT INTO gpkg_geometry_columns (table_name, column_name, geometry_type_name, srs_id) " +
        "VALUES (:t, 'geom', 'POINT', :s)",
      { ":t": table.name, ":s": table.srsId },
    );
    const blob = gpkgBlob(wkbPoint(index + 1, index + 2), table.srsId);
    db.run(`INSERT INTO "${table.name}" (geom, name) VALUES (:g, :n)`, {
      ":g": blob,
      ":n": `feature-${index}`,
    });
  }

  if (options.epsgRow) {
    db.run(
      "INSERT INTO gpkg_spatial_ref_sys (srs_id, organization, organization_coordsys_id) " +
        "VALUES (:s, :o, :c)",
      { ":s": srsId, ":o": "EPSG", ":c": srsId },
    );
  }

  const bytes = db.export() as Uint8Array;
  db.close();
  return bytes;
}

describe("stripGeoPackageHeader", () => {
  it("removes the GP header, exposing the inner WKB", () => {
    const wkb = wkbPoint(3, 4);
    const blob = gpkgBlob(wkb, 4326);
    expect(Array.from(stripGeoPackageHeader(blob))).toEqual(Array.from(wkb));
  });

  it("returns bare WKB unchanged", () => {
    const wkb = wkbPoint(3, 4);
    expect(stripGeoPackageHeader(wkb)).toBe(wkb);
  });

  it("throws on a reserved envelope indicator", () => {
    const blob = gpkgBlob(wkbPoint(0, 0), 4326);
    blob[3] = 0b00001110; // envelope indicator 7 (reserved)
    expect(() => stripGeoPackageHeader(blob)).toThrow(
      /reserved envelope indicator/,
    );
  });
});

describe("decodeWkb", () => {
  it("decodes a little-endian Point", () => {
    expect(decodeWkb(wkbPoint(10, 20))).toEqual({
      type: "Point",
      coordinates: [10, 20],
    });
  });

  it("throws on curved geometry types", () => {
    const buffer = new ArrayBuffer(5);
    const view = new DataView(buffer);
    view.setUint8(0, 1);
    view.setUint32(1, 8, true); // CircularString
    expect(() => decodeWkb(new Uint8Array(buffer))).toThrow(
      /curved geometries/,
    );
  });
});

describe("isLikelyGeoPackage", () => {
  it("accepts a GeoPackage buffer", () => {
    expect(isLikelyGeoPackage(buildGpkg())).toBe(true);
  });

  it("rejects a non-SQLite buffer", () => {
    expect(isLikelyGeoPackage(new TextEncoder().encode("nope"))).toBe(false);
  });
});

describe("readGeoPackageSync", () => {
  it("reads features and reports no EPSG for a WGS84 layer", () => {
    const { featureCollection, epsgCode } = readGeoPackageSync(
      SQL,
      buildGpkg(),
    );
    expect(epsgCode).toBeNull();
    expect(featureCollection.features).toHaveLength(1);
    const feature = featureCollection.features[0];
    expect(feature.geometry).toEqual({ type: "Point", coordinates: [1, 2] });
    // The INTEGER PRIMARY KEY (fid) and the geometry column are excluded.
    expect(feature.properties).toEqual({ name: "feature-0" });
  });

  it("reports the source EPSG code for a projected layer", () => {
    const { epsgCode } = readGeoPackageSync(
      SQL,
      buildGpkg({ srsId: 32643, epsgRow: true }),
    );
    expect(epsgCode).toBe(32643);
  });

  it("reads a named layer from a multi-layer GeoPackage", () => {
    const bytes = buildGpkg({
      tableName: "first",
      extraTables: [{ name: "second", srsId: 4326 }],
    });
    const { featureCollection } = readGeoPackageSync(SQL, bytes, "second");
    expect(featureCollection.features[0].properties).toEqual({
      name: "feature-1",
    });
  });

  it("throws when a requested layer is absent", () => {
    expect(() => readGeoPackageSync(SQL, buildGpkg(), "missing")).toThrow(
      /no feature layer named/,
    );
  });
});

describe("listGeoPackageLayersSync", () => {
  it("lists every feature table in declaration order", () => {
    const bytes = buildGpkg({
      tableName: "first",
      extraTables: [{ name: "second", srsId: 4326 }],
    });
    expect(listGeoPackageLayersSync(SQL, bytes)).toEqual(["first", "second"]);
  });
});
