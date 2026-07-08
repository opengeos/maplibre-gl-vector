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

/** Little-endian WKB for a single-ring 2D Polygon. */
function wkbPolygon(ring: Array<[number, number]>): Uint8Array {
  const buffer = new ArrayBuffer(9 + 4 + ring.length * 16);
  const view = new DataView(buffer);
  view.setUint8(0, 1); // little-endian
  view.setUint32(1, 3, true); // type = Polygon
  view.setUint32(5, 1, true); // ring count
  view.setUint32(9, ring.length, true); // point count
  let offset = 13;
  for (const [x, y] of ring) {
    view.setFloat64(offset, x, true);
    view.setFloat64(offset + 8, y, true);
    offset += 16;
  }
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

/** Builds a single-table GeoPackage from explicit (geomBlob, name) rows. */
function buildGpkgWithRows(
  rows: Array<{ geom: Uint8Array | null; name: string }>,
): Uint8Array {
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE gpkg_contents (
      table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL, srs_id INTEGER
    );
    CREATE TABLE gpkg_geometry_columns (
      table_name TEXT NOT NULL, column_name TEXT NOT NULL, srs_id INTEGER
    );
    CREATE TABLE "places" (fid INTEGER PRIMARY KEY, geom BLOB, name TEXT);
  `);
  db.run(
    "INSERT INTO gpkg_contents (table_name, data_type, srs_id) VALUES ('places', 'features', 4326)",
  );
  db.run(
    "INSERT INTO gpkg_geometry_columns (table_name, column_name, srs_id) VALUES ('places', 'geom', 4326)",
  );
  for (const row of rows) {
    db.run('INSERT INTO "places" (geom, name) VALUES (:g, :n)', {
      ":g": row.geom,
      ":n": row.name,
    });
  }
  const bytes = db.export() as Uint8Array;
  db.close();
  return bytes;
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

  it("skips a 32-byte XY envelope (indicator 1)", () => {
    const wkb = wkbPoint(3, 4);
    const blob = gpkgBlob(wkb, 4326);
    blob[3] = 0b00000011; // flags: little-endian header, envelope indicator 1
    const withEnvelope = new Uint8Array(blob.length + 32);
    withEnvelope.set(blob.subarray(0, 8), 0);
    // bytes 8..40 are the (zeroed) XY envelope; the WKB follows it.
    withEnvelope.set(wkb, 40);
    expect(Array.from(stripGeoPackageHeader(withEnvelope))).toEqual(
      Array.from(wkb),
    );
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

  it("decodes a Polygon", () => {
    const ring: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ];
    expect(decodeWkb(wkbPolygon(ring))).toEqual({
      type: "Polygon",
      coordinates: [ring],
    });
  });

  it("decodes a MultiPolygon", () => {
    const ring: Array<[number, number]> = [
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 0],
    ];
    const polygon = wkbPolygon(ring);
    const buffer = new Uint8Array(9 + polygon.length);
    const view = new DataView(buffer.buffer);
    view.setUint8(0, 1); // little-endian
    view.setUint32(1, 6, true); // type = MultiPolygon
    view.setUint32(5, 1, true); // polygon count
    buffer.set(polygon, 9);
    expect(decodeWkb(buffer)).toEqual({
      type: "MultiPolygon",
      coordinates: [[ring]],
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

  // ESRI MultiPatch shapefiles (3D buildings) come through GDAL as TIN /
  // Triangle / PolyhedralSurface WKB, which decodeWkb maps to a MultiPolygon.
  const u32 = (value: number): number[] => [
    value & 0xff,
    (value >> 8) & 0xff,
    (value >> 16) & 0xff,
    (value >> 24) & 0xff,
  ];
  const f64 = (value: number): number[] => {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value, true);
    return Array.from(bytes);
  };
  const ringBytes = (positions: Array<[number, number, number]>): number[] => [
    ...u32(positions.length),
    ...positions.flatMap(([x, y, z]) => [...f64(x), ...f64(y), ...f64(z)]),
  ];
  // A WKB Triangle Z (type 1017): one exterior ring.
  const triangle = (positions: Array<[number, number, number]>): number[] => [
    0x01,
    ...u32(1017),
    ...u32(1),
    ...ringBytes(positions),
  ];
  const triA: Array<[number, number, number]> = [
    [0, 0, 10],
    [1, 0, 10],
    [1, 1, 10],
    [0, 0, 10],
  ];
  const triB: Array<[number, number, number]> = [
    [1, 1, 20],
    [2, 1, 20],
    [2, 2, 20],
    [1, 1, 20],
  ];

  it("decodes a Triangle Z to a Polygon, keeping Z", () => {
    expect(decodeWkb(new Uint8Array(triangle(triA)))).toEqual({
      type: "Polygon",
      coordinates: [triA],
    });
  });

  it("decodes a TIN Z to a MultiPolygon (one polygon per triangle)", () => {
    const bytes = new Uint8Array([
      0x01,
      ...u32(1016), // TIN Z
      ...u32(2),
      ...triangle(triA),
      ...triangle(triB),
    ]);
    expect(decodeWkb(bytes)).toEqual({
      type: "MultiPolygon",
      coordinates: [[triA], [triB]],
    });
  });

  it("decodes a PolyhedralSurface Z to a MultiPolygon", () => {
    // Each patch is a Polygon Z (type 1003).
    const polygonZ = (positions: Array<[number, number, number]>): number[] => [
      0x01,
      ...u32(1003),
      ...u32(1),
      ...ringBytes(positions),
    ];
    const bytes = new Uint8Array([
      0x01,
      ...u32(1015), // PolyhedralSurface Z
      ...u32(2),
      ...polygonZ(triA),
      ...polygonZ(triB),
    ]);
    expect(decodeWkb(bytes)).toEqual({
      type: "MultiPolygon",
      coordinates: [[triA], [triB]],
    });
  });
});

describe("isLikelyGeoPackage", () => {
  it("accepts a GeoPackage buffer", () => {
    expect(isLikelyGeoPackage(buildGpkg())).toBe(true);
  });

  it("rejects a non-SQLite buffer", () => {
    expect(isLikelyGeoPackage(new TextEncoder().encode("nope"))).toBe(false);
  });

  it("accepts a plain SQLite database (best-effort SQLite-magic check)", () => {
    // Only the SQLite magic is inspected, so a non-GeoPackage SQLite file also
    // passes; it then surfaces "no feature layer" when read, not a hang.
    const db = new SQL.Database();
    db.run("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
    const bytes = db.export() as Uint8Array;
    db.close();
    expect(isLikelyGeoPackage(bytes)).toBe(true);
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

  it("skips an undecodable geometry without failing the whole read", () => {
    // A blob with the "GP" magic but a curved-type WKB body throws in decode;
    // the feature must survive with a null geometry and the rest still load.
    const curved = new Uint8Array(5);
    new DataView(curved.buffer).setUint32(1, 8, true); // CircularString
    curved[0] = 1;
    const bytes = buildGpkgWithRows([
      { geom: gpkgBlob(wkbPoint(1, 2), 4326), name: "good" },
      { geom: gpkgBlob(curved, 4326), name: "bad" },
    ]);
    const { featureCollection } = readGeoPackageSync(SQL, bytes);
    expect(featureCollection.features).toHaveLength(2);
    const byName = new Map(
      featureCollection.features.map((f) => [f.properties?.name, f.geometry]),
    );
    expect(byName.get("good")).toEqual({ type: "Point", coordinates: [1, 2] });
    expect(byName.get("bad")).toBeNull();
  });

  it("yields a null geometry for an empty-flagged blob and a null blob", () => {
    const empty = gpkgBlob(wkbPoint(0, 0), 4326);
    empty[3] |= 0x10; // set the empty-geometry flag
    const bytes = buildGpkgWithRows([
      { geom: empty, name: "empty" },
      { geom: null, name: "null" },
    ]);
    const { featureCollection } = readGeoPackageSync(SQL, bytes);
    expect(featureCollection.features.map((f) => f.geometry)).toEqual([
      null,
      null,
    ]);
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
