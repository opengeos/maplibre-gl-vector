import { getMaplibre } from '../utils/maplibre';

/**
 * Custom protocol scheme used for dynamic DuckDB tiles.
 */
export const TILE_PROTOCOL = 'duckdb';

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
let protocolRegistered = false;

/**
 * Builds the tile URL template for a registered tile provider.
 *
 * The key is URI-encoded so it round-trips through parseTileUrl even
 * when it contains reserved characters.
 *
 * @param providerKey - The provider registry key
 * @returns The duckdb:// tile URL template
 */
export function tileUrlFor(providerKey: string): string {
  return `${TILE_PROTOCOL}://${encodeURIComponent(providerKey)}/{z}/{x}/{y}`;
}

/**
 * Parsed components of a duckdb:// tile URL.
 */
export interface ParsedTileUrl {
  providerKey: string;
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
    providerKey: decodeURIComponent(match[1]),
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

  const provider = providers.get(parsed.providerKey);
  if (!provider) return new Uint8Array(0);

  return provider(parsed.z, parsed.x, parsed.y, signal);
}

/**
 * Registers a tile provider, installing the duckdb:// protocol handler
 * on first use.
 *
 * The registry is process-wide, so callers must pass a globally unique
 * key (not the public layer id, which can repeat across controls).
 *
 * Resolves once the protocol handler is installed, so a tile source
 * added afterwards is guaranteed to find it.
 *
 * @param providerKey - Globally unique provider registry key
 * @param provider - The tile provider
 */
export async function registerTileProvider(
  providerKey: string,
  provider: TileProvider,
): Promise<void> {
  providers.set(providerKey, provider);
  if (!protocolRegistered) {
    const api = await getMaplibre();
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
 * Removes a tile provider, uninstalling the protocol handler when no
 * providers remain.
 *
 * @param providerKey - The provider registry key
 */
export function unregisterTileProvider(providerKey: string): void {
  providers.delete(providerKey);
  if (providers.size === 0 && protocolRegistered) {
    protocolRegistered = false;
    void getMaplibre().then((api) => {
      // Re-check: a provider may have been registered meanwhile.
      if (providers.size === 0) api.removeProtocol(TILE_PROTOCOL);
    });
  }
}

/**
 * Returns whether a tile provider is registered for a key.
 *
 * @param providerKey - The provider registry key
 * @returns True when a provider is registered
 */
export function hasTileProvider(providerKey: string): boolean {
  return providers.has(providerKey);
}
