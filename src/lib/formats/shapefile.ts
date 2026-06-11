import { unzipSync } from 'fflate';

/** Strips the final extension from a zip entry path (keeps any directory). */
function stripExtension(entryName: string): string {
  return entryName.replace(/\.[^./]+$/, '');
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
 * @returns The registered `.shp` path to hand to ST_Read.
 */
export async function registerZippedShapefile(
  zip: Uint8Array,
  baseName: string,
  register: (name: string, bytes: Uint8Array) => Promise<void> | void,
): Promise<string> {
  const files = unzipSync(zip);
  const shpEntry = Object.keys(files).find((name) => /\.shp$/i.test(name));
  if (!shpEntry) {
    throw new Error('Zip archive does not contain a .shp file.');
  }

  const base = stripExtension(shpEntry);
  let shpPath = '';
  for (const [entry, bytes] of Object.entries(files)) {
    // Only this shapefile's sidecars (same base path, any extension).
    if (stripExtension(entry) !== base) continue;
    const extension = entry.slice(entry.lastIndexOf('.')).toLowerCase();
    const registeredName = `${baseName}${extension}`;
    await register(registeredName, bytes);
    if (extension === '.shp') shpPath = registeredName;
  }

  return shpPath;
}
