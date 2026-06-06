/**
 * Custom protocol scheme used for dynamic DuckDB tiles.
 */
export const TILE_PROTOCOL = 'duckdb';

/**
 * The subset of the maplibre-gl module used to manage protocols.
 */
interface ProtocolApi {
  addProtocol(
    name: string,
    loadFn: (
      params: { url: string },
      abortController: AbortController,
    ) => Promise<{ data: Uint8Array }>,
  ): void;
  removeProtocol(name: string): void;
}

/**
 * Produces an MVT tile for a z/x/y request.
 */
export type TileProvider = (
  z: number,
  x: number,
  y: number,
  signal: AbortSignal,
) => Promise<Uint8Array>;

const providers = new Map<string, TileProvider>();
let apiPromise: Promise<ProtocolApi> | undefined;
let protocolRegistered = false;

/**
 * Resolves the maplibre-gl module providing addProtocol/removeProtocol.
 *
 * The global `maplibregl` (UMD build or host app) is preferred so the
 * protocol lands on the SAME module instance that owns the map; a
 * bundled second copy of maplibre-gl would register the protocol where
 * the host map never looks. Falls back to importing the peer
 * dependency.
 */
function getProtocolApi(): Promise<ProtocolApi> {
  if (!apiPromise) {
    const globalMaplibre = (globalThis as Record<string, unknown>).maplibregl as
      | ProtocolApi
      | undefined;
    if (globalMaplibre && typeof globalMaplibre.addProtocol === 'function') {
      apiPromise = Promise.resolve(globalMaplibre);
    } else {
      apiPromise = import('maplibre-gl').then(
        (module) => (module.default ?? module) as unknown as ProtocolApi,
      );
    }
    apiPromise.catch(() => {
      apiPromise = undefined;
    });
  }
  return apiPromise;
}

/**
 * Builds the tile URL template for a vector layer.
 *
 * @param layerId - The vector layer id
 * @returns The duckdb:// tile URL template
 */
export function tileUrlFor(layerId: string): string {
  return `${TILE_PROTOCOL}://${layerId}/{z}/{x}/{y}`;
}

/**
 * Parsed components of a duckdb:// tile URL.
 */
export interface ParsedTileUrl {
  layerId: string;
  z: number;
  x: number;
  y: number;
}

/**
 * Parses a duckdb:// tile URL into its components.
 *
 * @param url - The request URL
 * @returns The parsed components, or null when the URL is not a tile URL
 */
export function parseTileUrl(url: string): ParsedTileUrl | null {
  const match = new RegExp(`^${TILE_PROTOCOL}://([^/]+)/(\\d+)/(\\d+)/(\\d+)(?:\\.pbf)?$`).exec(
    url,
  );
  if (!match) return null;
  return {
    layerId: match[1],
    z: Number(match[2]),
    x: Number(match[3]),
    y: Number(match[4]),
  };
}

/**
 * Handles a tile request for the duckdb:// protocol.
 *
 * Unknown layers resolve to an empty tile so requests in flight during
 * layer removal do not surface errors.
 *
 * @param url - The request URL
 * @param signal - Abort signal from MapLibre
 * @returns The tile bytes
 */
export async function loadTile(url: string, signal: AbortSignal): Promise<Uint8Array> {
  const parsed = parseTileUrl(url);
  if (!parsed) {
    throw new Error(`Invalid ${TILE_PROTOCOL}:// tile URL: ${url}`);
  }

  const provider = providers.get(parsed.layerId);
  if (!provider) return new Uint8Array(0);

  return provider(parsed.z, parsed.x, parsed.y, signal);
}

/**
 * Registers the tile provider for a vector layer, installing the
 * duckdb:// protocol handler on first use.
 *
 * Resolves once the protocol handler is installed, so a tile source
 * added afterwards is guaranteed to find it.
 *
 * @param layerId - The vector layer id
 * @param provider - The tile provider
 */
export async function registerTileProvider(layerId: string, provider: TileProvider): Promise<void> {
  providers.set(layerId, provider);
  if (!protocolRegistered) {
    const api = await getProtocolApi();
    if (!protocolRegistered) {
      api.addProtocol(TILE_PROTOCOL, async (params, abortController) => {
        const data = await loadTile(params.url, abortController.signal);
        return { data };
      });
      protocolRegistered = true;
    }
  }
}

/**
 * Removes the tile provider for a vector layer, uninstalling the
 * protocol handler when no providers remain.
 *
 * @param layerId - The vector layer id
 */
export function unregisterTileProvider(layerId: string): void {
  providers.delete(layerId);
  if (providers.size === 0 && protocolRegistered) {
    protocolRegistered = false;
    void getProtocolApi().then((api) => {
      // Re-check: a provider may have been registered meanwhile.
      if (providers.size === 0) api.removeProtocol(TILE_PROTOCOL);
    });
  }
}

/**
 * Returns whether a tile provider is registered for a layer.
 *
 * @param layerId - The vector layer id
 * @returns True when a provider is registered
 */
export function hasTileProvider(layerId: string): boolean {
  return providers.has(layerId);
}
