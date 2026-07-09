import { unzipSync } from 'fflate';

/** Strips the final extension from a zip entry path (keeps any directory). */
function stripExtension(entryName: string): string {
  return entryName.replace(/\.[^./]+$/, '');
}

/**
 * True for the metadata entries macOS adds when it creates a zip: the
 * `__MACOSX/` resource-fork tree and the AppleDouble `._<name>` files that
 * shadow every real entry. These must be ignored, because an AppleDouble
 * `._states.shp` matches a naive `.shp` search and would otherwise be picked as
 * the shapefile (a few hundred bytes of resource-fork data GDAL rejects with
 * "not recognized as a supported file format") instead of the real `.shp`.
 */
function isMacOsMetadataEntry(entryName: string): boolean {
  const baseName = entryName.slice(entryName.lastIndexOf('/') + 1);
  return entryName.startsWith('__MACOSX/') || baseName.startsWith('._');
}

/**
 * Shapefile sidecar extensions (without the dot) that ride along with a `.shp`
 * when the loose components are selected together. GDAL needs at least `.shx`
 * and `.dbf`; the projection (`.prj`), encoding (`.cpg`) and spatial-index
 * sidecars are registered too when present so they are honored and do not load
 * as their own (unreadable) layers.
 */
export const SHAPEFILE_SIDECAR_EXTENSIONS = new Set([
  'shx',
  'dbf',
  'prj',
  'cpg',
  'sbn',
  'sbx',
  'qix',
  'qpj',
  'cst',
  'aih',
  'ain',
  'atx',
  'ixs',
  'mxs',
  'fbn',
  'fbx',
]);

/** A `.shp` paired with the sidecar files selected alongside it. */
export interface ShapefileGroup<T> {
  /** A `.shp` file, or any non-shapefile file (which has no companions). */
  file: T;
  /** Sidecar files sharing the `.shp`'s base name (empty for non-`.shp`). */
  companions: T[];
}

function lowerExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

function lowerBaseName(name: string): string {
  const dot = name.lastIndexOf('.');
  return (dot < 0 ? name : name.slice(0, dot)).toLowerCase();
}

/**
 * Groups a batch of selected files so each `.shp` carries the sidecar files
 * picked alongside it (same base name, a known shapefile sidecar extension),
 * and those sidecars do not also load as their own layers.
 *
 * Files that are not part of a shapefile pass through unchanged with no
 * companions, preserving their original order. A sidecar with no matching
 * `.shp` in the batch is left as a standalone file (it is the caller's, and
 * may be a legitimate `.dbf`/`.csv`-style table).
 *
 * @param files - The selected files (anything with a `name`).
 * @returns One group per file that should load, in input order.
 */
export function groupShapefileComponents<T extends { name: string }>(
  files: T[],
): Array<ShapefileGroup<T>> {
  const shpFiles = files.filter((f) => /\.shp$/i.test(f.name));
  const claimed = new Set<T>();
  const companionsByShp = new Map<T, T[]>();

  for (const shp of shpFiles) {
    const base = lowerBaseName(shp.name);
    const companions = files.filter(
      (f) =>
        f !== shp &&
        !/\.shp$/i.test(f.name) &&
        lowerBaseName(f.name) === base &&
        SHAPEFILE_SIDECAR_EXTENSIONS.has(lowerExtension(f.name)),
    );
    companions.forEach((c) => claimed.add(c));
    companionsByShp.set(shp, companions);
  }

  const groups: Array<ShapefileGroup<T>> = [];
  for (const file of files) {
    if (claimed.has(file)) continue;
    groups.push({ file, companions: companionsByShp.get(file) ?? [] });
  }
  return groups;
}

/**
 * Registers the components of a zipped shapefile individually and returns the
 * registered `.shp` path.
 *
 * GDAL's `/vsizip/` handler cannot read a DuckDB-WASM `registerFileBuffer`
 * archive: the virtual filesystem `/vsizip/` opens through is GDAL's own, not
 * DuckDB's registered-file VFS, so `ST_Read('/vsizip/<registered>.zip')` fails
 * with "Could not open GDAL dataset". Unzipping in the browser and registering
 * each sidecar (`.dbf`, `.shx`, `.prj`, ...) under a shared base name lets
 * GDAL's shapefile driver resolve the siblings by name when reading the `.shp`
 * directly.
 *
 * Only the first shapefile in the archive is registered; its sidecars are the
 * entries sharing its base path. A trailing directory in the zip is dropped so
 * the components register as flat siblings.
 *
 * @param zip - The raw zip archive bytes.
 * @param baseName - The registration base (the returned path is `${baseName}.shp`).
 * @param register - Registers one file buffer with the database.
 * @returns The registered `.shp` path plus the `.prj` WKT (for reprojection).
 */
export async function registerZippedShapefile(
  zip: Uint8Array,
  baseName: string,
  register: (name: string, bytes: Uint8Array) => Promise<void> | void,
): Promise<RegisteredShapefile> {
  const files = unzipSync(zip);
  const shpEntry = Object.keys(files).find(
    (name) => /\.shp$/i.test(name) && !isMacOsMetadataEntry(name),
  );
  if (!shpEntry) {
    throw new Error('Zip archive does not contain a .shp file.');
  }

  const base = stripExtension(shpEntry);
  let shpPath = '';
  let prjWkt: string | null = null;
  for (const [entry, bytes] of Object.entries(files)) {
    // Only this shapefile's sidecars (same base path, any extension), never a
    // macOS AppleDouble shadow of one.
    if (isMacOsMetadataEntry(entry) || stripExtension(entry) !== base) continue;
    const extension = entry.slice(entry.lastIndexOf('.')).toLowerCase();
    const registeredName = `${baseName}${extension}`;
    // Capture the `.prj` WKT before registering, since registerFileBuffer may
    // transfer (and detach) the buffer. It is the reprojection-source fallback
    // when ST_Read_Meta cannot report the CRS (e.g. an OSGB36 grid-shift datum).
    if (extension === '.prj') {
      const text = new TextDecoder().decode(bytes).trim();
      if (text) prjWkt = text;
    }
    await register(registeredName, bytes);
    if (extension === '.shp') shpPath = registeredName;
  }

  return { shpPath, prjWkt };
}

/** What {@link registerZippedShapefile} resolves to. */
export interface RegisteredShapefile {
  /** The registered `.shp` path to hand to ST_Read. */
  shpPath: string;
  /** The `.prj` sidecar's WKT text, or null when the archive carries none. */
  prjWkt: string | null;
}

/** One component of a loose shapefile: its lowercased extension and bytes. */
export interface ShapefileComponent {
  /** Lowercased file extension including the leading dot (e.g. `.dbf`). */
  extension: string;
  /** The component's raw bytes. */
  bytes: Uint8Array;
}

/**
 * Registers the components of a loose shapefile (a `.shp` and its sidecar
 * files picked together, rather than packed in a zip) under a shared base
 * name and returns the registered `.shp` path.
 *
 * A `.shp` alone is unreadable: GDAL's shapefile driver needs at least the
 * `.shx` and `.dbf` siblings, and fails with "GDALOpen() called on x.shp
 * recursively" when they are missing. Registering every component the caller
 * holds under one base name lets GDAL resolve the siblings by name when
 * reading the `.shp` directly, mirroring how {@link registerZippedShapefile}
 * handles a zipped shapefile.
 *
 * @param shp - The `.shp` file bytes.
 * @param components - The sidecar components (any extension other than `.shp`).
 * @param baseName - The registration base (the returned path is `${baseName}.shp`).
 * @param register - Registers one file buffer with the database.
 * @returns The registered `.shp` path to hand to ST_Read.
 */
export async function registerLooseShapefile(
  shp: Uint8Array,
  components: ShapefileComponent[],
  baseName: string,
  register: (name: string, bytes: Uint8Array) => Promise<void> | void,
): Promise<string> {
  const shpPath = `${baseName}.shp`;
  await register(shpPath, shp);
  for (const { extension, bytes } of components) {
    const ext = (extension.startsWith('.') ? extension : `.${extension}`).toLowerCase();
    if (ext === '.shp') continue;
    await register(`${baseName}${ext}`, bytes);
  }
  return shpPath;
}
