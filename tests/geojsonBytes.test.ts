import { describe, expect, it } from "vitest";
import type { FeatureCollection, Geometry } from "geojson";
import {
  encodeFeatureCollection,
  sliceFeatureCollection,
} from "../src/lib/engine/geojsonBytes";

const decode = (bytes: Uint8Array): unknown =>
  JSON.parse(new TextDecoder().decode(bytes));

const point = (x: number, y: number) => ({
  type: "Feature" as const,
  properties: { x },
  geometry: { type: "Point" as const, coordinates: [x, y] },
});

const collection = (count: number): FeatureCollection<Geometry | null> => ({
  type: "FeatureCollection",
  features: Array.from({ length: count }, (_unused, index) =>
    point(index, index),
  ),
});

describe("encodeFeatureCollection", () => {
  it("round-trips to the same document JSON.stringify would produce", () => {
    const source = collection(3);
    expect(decode(encodeFeatureCollection(source))).toEqual(
      JSON.parse(JSON.stringify(source)),
    );
  });

  it("encodes an empty collection", () => {
    const source: FeatureCollection<Geometry | null> = {
      type: "FeatureCollection",
      features: [],
    };
    expect(decode(encodeFeatureCollection(source))).toEqual({
      type: "FeatureCollection",
      features: [],
    });
  });

  it("preserves top-level members other than features", () => {
    const source = {
      type: "FeatureCollection" as const,
      name: "wetlands",
      bbox: [-1, -2, 3, 4],
      features: [point(1, 2)],
    };
    const decoded = decode(encodeFeatureCollection(source)) as Record<
      string,
      unknown
    >;
    expect(decoded.name).toBe("wetlands");
    expect(decoded.bbox).toEqual([-1, -2, 3, 4]);
    expect((decoded.features as unknown[]).length).toBe(1);
  });

  it("keeps null geometries, which the GeoPackage reader can emit", () => {
    const source: FeatureCollection<Geometry | null> = {
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: { a: 1 }, geometry: null }],
    };
    expect(decode(encodeFeatureCollection(source))).toEqual(source);
  });

  it("emits UTF-8 bytes for non-ASCII property values", () => {
    const source: FeatureCollection<Geometry | null> = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { name: "Tennessee — wetlands ✓" },
          geometry: null,
        },
      ],
    };
    const decoded = decode(
      encodeFeatureCollection(source),
    ) as FeatureCollection;
    expect(decoded.features[0].properties?.name).toBe("Tennessee — wetlands ✓");
  });

  it("never builds one string for the whole document", () => {
    // The regression this exists for: JSON.stringify over a large collection
    // throws `RangeError: Invalid string length`. Proven by making the whole
    // document unstringifiable while each feature stays small.
    const source = collection(200);
    const originalStringify = JSON.stringify;
    let sawWholeDocument = false;
    try {
      JSON.stringify = ((value: unknown, ...rest: unknown[]) => {
        if (
          typeof value === "object" &&
          value !== null &&
          (value as { features?: unknown[] }).features !== undefined &&
          ((value as { features: unknown[] }).features?.length ?? 0) > 0
        ) {
          sawWholeDocument = true;
          throw new RangeError("Invalid string length");
        }
        return (originalStringify as (v: unknown, ...r: unknown[]) => string)(
          value,
          ...rest,
        );
      }) as typeof JSON.stringify;
      const bytes = encodeFeatureCollection(source);
      expect((decode(bytes) as FeatureCollection).features).toHaveLength(200);
    } finally {
      JSON.stringify = originalStringify;
    }
    expect(sawWholeDocument).toBe(false);
  });
});

describe("sliceFeatureCollection", () => {
  it("splits into batches of at most the given size", () => {
    const slices = sliceFeatureCollection(collection(250), 100);
    expect(slices.map((slice) => slice.features.length)).toEqual([
      100, 100, 50,
    ]);
  });

  it("returns one slice when the collection fits", () => {
    expect(sliceFeatureCollection(collection(10), 50)).toHaveLength(1);
  });

  it("returns a single empty slice for an empty collection", () => {
    const slices = sliceFeatureCollection(
      { type: "FeatureCollection", features: [] },
      50,
    );
    expect(slices).toHaveLength(1);
    expect(slices[0].features).toEqual([]);
  });

  it("copies top-level members onto every slice", () => {
    const source = {
      type: "FeatureCollection" as const,
      name: "wetlands",
      features: collection(5).features,
    };
    for (const slice of sliceFeatureCollection(source, 2)) {
      expect((slice as unknown as { name: string }).name).toBe("wetlands");
      expect(slice.type).toBe("FeatureCollection");
    }
  });

  it("preserves every feature across the batches, in order", () => {
    const source = collection(37);
    const rejoined = sliceFeatureCollection(source, 8).flatMap(
      (slice) => slice.features,
    );
    expect(rejoined).toEqual(source.features);
  });

  it("rejects a non-positive batch size", () => {
    expect(() => sliceFeatureCollection(collection(1), 0)).toThrow(
      /greater than zero/,
    );
  });
});
