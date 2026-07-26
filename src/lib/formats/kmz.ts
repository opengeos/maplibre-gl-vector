import { unzipSync } from 'fflate';
import { isMacOsMetadataEntry } from './shapefile';

/**
 * KMZ archive handling.
 *
 * A KMZ is a zip whose payload is one or more KML documents (plus any
 * icons, overlays and models they reference). GDAL can read the KML
 * inside one, but only through its own `/vsizip` handler, which cannot
 * open a DuckDB-WASM `registerFileBuffer` archive: `/vsizip` reads
 * through GDAL's virtual filesystem, not DuckDB's registered-file VFS.
 * The same limitation is why a zipped shapefile is unzipped and its
 * components registered individually (see `registerZippedShapefile`).
 *
 * So a KMZ is unzipped here and its KML entry is registered on its own,
 * which readers then open directly as plain KML. This makes both a local
 * `.kmz` and a remote `.kmz` URL loadable; previously a local one failed
 * with "not recognized as a supported file format" and a remote one with
 * an opaque `XMLHttpRequest` error naming a sibling path GDAL had probed.
 */

/** The KML entry lifted out of a KMZ archive. */
export interface KmzKmlEntry {
  /** The entry's path inside the archive (for display and naming). */
  entryName: string;
  /** The KML document's bytes. */
  bytes: Uint8Array;
}

/**
 * Picks the KML document a KMZ archive should be read as.
 *
 * The KML spec names the main document `doc.kml`, but writers are free to
 * use anything (NASA FIRMS, for one, ships a single timestamped name), so
 * `doc.kml` is preferred when present and the first `.kml` entry is used
 * otherwise. Entries are sorted for a deterministic pick, and the macOS
 * archive metadata (`__MACOSX/`, `._` AppleDouble shadows) is skipped so a
 * resource fork is never mistaken for the document.
 *
 * @param entryNames - Every entry path in the archive
 * @returns The chosen KML entry path, or undefined when there is none
 */
export function pickKmlEntry(entryNames: string[]): string | undefined {
  const kmlEntries = entryNames
    .filter((name) => /\.kml$/i.test(name) && !isMacOsMetadataEntry(name))
    .sort();
  return (
    kmlEntries.find(
      (name) => name.slice(name.lastIndexOf('/') + 1).toLowerCase() === 'doc.kml',
    ) ?? kmlEntries[0]
  );
}

/**
 * Unzips a KMZ archive and returns the KML document inside it.
 *
 * @param kmz - The KMZ archive's bytes
 * @returns The KML entry to read
 * @throws Error when the archive is unreadable or holds no KML
 */
export function extractKmzKml(kmz: Uint8Array): KmzKmlEntry {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(kmz);
  } catch {
    // A KMZ that is not a valid zip is usually an error page or a
    // truncated download, which the raw fflate message does not convey.
    throw new Error('This KMZ file could not be unzipped; it may be corrupt or incomplete.');
  }
  const entryName = pickKmlEntry(Object.keys(files));
  if (!entryName) {
    throw new Error('KMZ archive does not contain a .kml file.');
  }
  return { entryName, bytes: files[entryName] };
}
