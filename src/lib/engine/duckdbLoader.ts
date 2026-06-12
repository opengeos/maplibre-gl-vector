import { mvtProbeQuery } from './sql';

/**
 * Pinned duckdb-wasm version.
 *
 * IMPORTANT: a higher duckdb-wasm version does NOT guarantee a newer
 * DuckDB core. v1.31.0 ships DuckDB core 1.4.0, which is the first core
 * with ST_AsMVT/ST_AsMVTGeom; some later wasm releases regressed to
 * core 1.3.x. Verify with the runtime probe before changing this pin.
 */
export const DUCKDB_WASM_VERSION = '1.31.0';

/**
 * jsDelivr base URL for the pinned duckdb-wasm package. Used as the default
 * when no custom base is configured.
 */
export const DUCKDB_CDN_BASE = `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${DUCKDB_WASM_VERSION}`;

/**
 * Rewrites the jsDelivr URLs returned by `getJsDelivrBundles()` to a custom
 * base so the `.wasm` and worker assets load from a self-hosted (or mirrored)
 * location instead of the CDN.
 *
 * The base must mirror jsDelivr's layout for duckdb-wasm
 * {@link DUCKDB_WASM_VERSION}: an `/+esm` ES-module bundle plus the `/dist/*`
 * wasm and worker files. A trailing slash on the base is ignored.
 *
 * @param bundles - Bundle map from duckdb-wasm's `getJsDelivrBundles()`.
 * @param base - Target base URL (e.g. `/vendor/duckdb-wasm-1.31.0`).
 * @returns A new bundle map with rebased URLs (the default base is a no-op).
 */
export function rebaseDuckDBBundles<T>(bundles: T, base: string): T {
  const normalized = base.replace(/\/+$/, '');
  if (normalized === DUCKDB_CDN_BASE) return bundles;
  const rebased = JSON.stringify(bundles).split(DUCKDB_CDN_BASE).join(normalized);
  return JSON.parse(rebased) as T;
}

/**
 * Minimal structural types for the duckdb-wasm API surface we use.
 * Full types are not imported because the package is loaded from a CDN
 * at runtime and is not a dependency.
 */
export interface DuckDBConnection {
  query(text: string): Promise<ArrowTable>;
  close(): Promise<void>;
}

export interface ArrowTable {
  numRows: number;
  toArray(): Array<Record<string, unknown>>;
}

export interface DuckDBDatabase {
  connect(): Promise<DuckDBConnection>;
  registerFileBuffer(name: string, buffer: Uint8Array): Promise<void>;
  registerFileURL(name: string, url: string, protocol: number, directIO: boolean): Promise<void>;
  dropFile(name: string): Promise<void>;
  terminate(): Promise<void>;
}

/**
 * A loaded DuckDB instance with its primary connection.
 */
export interface LoadedDuckDB {
  db: DuckDBDatabase;
  conn: DuckDBConnection;
  /** Whether the spatial build supports native ST_AsMVT tiles */
  supportsMVT: boolean;
  /** DuckDB core version string */
  version: string;
  /** The HTTP value of duckdb-wasm's DuckDBDataProtocol enum */
  httpProtocol: number;
}

/**
 * Imports a module by URL at runtime without bundler interference.
 * Indirection through Function keeps Vite/webpack/rollup from trying to
 * resolve or rewrite the CDN import.
 */
const dynamicImport = new Function('url', 'return import(url)') as (
  url: string,
) => Promise<Record<string, unknown>>;

/**
 * Loads a remote ES module from a URL.
 *
 * Exported for reuse by the MVT JS fallback loader.
 *
 * @param url - Module URL
 * @returns The module namespace object
 */
export function importFromCdn(url: string): Promise<Record<string, unknown>> {
  return dynamicImport(url);
}

const cdnScriptPromises = new Map<string, Promise<void>>();

/**
 * Loads a classic (non-module) script from a URL via a `<script>` tag, once per
 * URL. Used for UMD CDN bundles that publish a global rather than an ES module
 * (e.g. sql.js, whose `/+esm` build cannot be bundled because it imports `fs`).
 *
 * @param url - Script URL
 * @returns Resolves when the script has loaded
 */
export function loadScriptFromCdn(url: string): Promise<void> {
  let promise = cdnScriptPromises.get(url);
  if (!promise) {
    promise = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = url;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        cdnScriptPromises.delete(url);
        reject(new Error(`Failed to load script: ${url}`));
      };
      document.head.appendChild(script);
    });
    cdnScriptPromises.set(url, promise);
  }
  return promise;
}

/**
 * Loads DuckDB-WASM from jsDelivr, instantiates it in a worker, loads
 * the spatial extension, and probes MVT support.
 *
 * @param onProgress - Optional progress message callback
 * @param baseUrl - Optional base URL to load duckdb-wasm from instead of
 *   jsDelivr. Must mirror jsDelivr's layout (`/+esm` plus `/dist/*`) for the
 *   pinned {@link DUCKDB_WASM_VERSION}; lets a host self-host the assets and
 *   avoid the CDN (and the CSP allowance it requires).
 * @returns The loaded database, connection, and capabilities
 */
export async function loadDuckDB(
  onProgress?: (message: string) => void,
  baseUrl?: string,
): Promise<LoadedDuckDB> {
  onProgress?.('Loading DuckDB-WASM...');
  const base = (baseUrl ?? DUCKDB_CDN_BASE).replace(/\/+$/, '');
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const duckdb: any = await dynamicImport(`${base}/+esm`);

  const bundles = rebaseDuckDBBundles(duckdb.getJsDelivrBundles(), base);
  const bundle = await duckdb.selectBundle(bundles);

  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' }),
  );
  const worker = new Worker(workerUrl);
  const logger = new duckdb.VoidLogger();
  const db: any = new duckdb.AsyncDuckDB(logger, worker);
  try {
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  } finally {
    URL.revokeObjectURL(workerUrl);
  }

  onProgress?.('Loading spatial extension...');
  const conn: DuckDBConnection = await db.connect();
  await conn.query('INSTALL spatial; LOAD spatial;');

  const versionRows = (await conn.query('SELECT version() AS v')).toArray();
  const version = String(versionRows[0]?.v ?? 'unknown');

  let supportsMVT = false;
  try {
    await conn.query(mvtProbeQuery());
    supportsMVT = true;
  } catch {
    // Older core without ST_AsMVT; the JS fallback encoder is used instead.
  }

  const httpProtocol = Number(duckdb.DuckDBDataProtocol?.HTTP ?? 4);
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return { db: db as DuckDBDatabase, conn, supportsMVT, version, httpProtocol };
}
