import type { FeatureCollection, Geometry } from "geojson";

/**
 * Serializes a FeatureCollection to UTF-8 JSON bytes without ever holding the
 * whole document as one JavaScript string.
 *
 * `JSON.stringify` throws `RangeError: Invalid string length` once the result
 * would exceed the engine's maximum string length — 536,870,888 bytes on V8 —
 * which a few hundred thousand polygon features reach easily (a statewide
 * wetlands GeoPackage does it with room to spare). Because the GeoPackage
 * reader hands DuckDB its rows as GeoJSON rather than through GDAL (see
 * `geopackage.ts`), that cap was a hard ceiling on how large a GeoPackage the
 * control could open at all.
 *
 * Serializing feature by feature keeps every intermediate string small. It also
 * lowers peak memory: the UTF-16 string and its UTF-8 copy no longer coexist
 * for the entire document, only for one feature at a time.
 *
 * @param collection - The collection to encode. Top-level members other than
 *   `features` (`type`, `bbox`, `crs`, …) are preserved.
 * @returns The encoded document as UTF-8 bytes.
 */
export function encodeFeatureCollection(
  collection: FeatureCollection<Geometry | null>,
): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const write = (text: string): void => {
    const bytes = encoder.encode(text);
    chunks.push(bytes);
    total += bytes.byteLength;
  };

  const { features, ...rest } = collection;
  // `features` is re-added last, and JSON.stringify emits string keys in
  // insertion order, so the head always ends with the literal `"features":[]}`.
  // Dropping its final two characters leaves the array open to stream into.
  const head = JSON.stringify({ ...rest, features: [] });
  write(head.slice(0, -2));
  for (let index = 0; index < features.length; index += 1) {
    write(
      index === 0
        ? JSON.stringify(features[index])
        : `,${JSON.stringify(features[index])}`,
    );
  }
  write("]}");

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Splits a collection into slices of at most `size` features, preserving every
 * other top-level member on each slice so each one is a valid FeatureCollection
 * in its own right.
 *
 * Used to ingest a large GeoPackage in batches: one registered file per slice
 * caps peak memory at a single batch instead of the whole layer, which is the
 * difference between opening a half-million-feature layer and exhausting the
 * tab.
 *
 * @param collection - The collection to split.
 * @param size - Maximum features per slice; must be a positive safe integer.
 * @returns One slice per batch, or a single empty slice for an empty input.
 */
export function sliceFeatureCollection(
  collection: FeatureCollection<Geometry | null>,
  size: number,
): FeatureCollection<Geometry | null>[] {
  // Rejected rather than coerced: NaN slips past a `<= 0` guard and yields one
  // empty slice, silently dropping every feature, and a fractional size gives
  // truncated `Array.prototype.slice` bounds that can repeat or omit features.
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new Error("Batch size must be a positive integer.");
  }
  const { features, ...rest } = collection;
  if (features.length === 0) return [{ ...rest, features: [] }];
  const slices: FeatureCollection<Geometry | null>[] = [];
  for (let start = 0; start < features.length; start += size) {
    slices.push({ ...rest, features: features.slice(start, start + size) });
  }
  return slices;
}
