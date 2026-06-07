/**
 * Lazy access to the maplibre-gl module without a static value import.
 *
 * The global `maplibregl` (UMD build or host app) is preferred so
 * module-level registries like addProtocol land on the SAME module
 * instance that owns the map; a bundled second copy of maplibre-gl
 * would register them where the host map never looks. Falls back to
 * importing the peer dependency.
 */

import type { LngLat, Map as MapLibreMap } from 'maplibre-gl';

/**
 * The subset of the maplibre-gl module surface this library uses.
 */
export interface MaplibreModule {
  addProtocol(
    name: string,
    loadFn: (
      params: { url: string },
      abortController: AbortController,
    ) => Promise<{ data: Uint8Array }>,
  ): void;
  removeProtocol(name: string): void;
  Popup: new (options?: {
    closeButton?: boolean;
    maxWidth?: string;
    className?: string;
  }) => {
    setLngLat(lngLat: LngLat | [number, number]): unknown;
    setDOMContent(node: Node): unknown;
    addTo(map: MapLibreMap): unknown;
    remove(): void;
  };
}

let modulePromise: Promise<MaplibreModule> | undefined;

/**
 * Resolves the maplibre-gl module, preferring the global instance.
 *
 * @returns The maplibre-gl module
 */
export function getMaplibre(): Promise<MaplibreModule> {
  if (!modulePromise) {
    const globalMaplibre = (globalThis as Record<string, unknown>).maplibregl as
      | MaplibreModule
      | undefined;
    if (globalMaplibre && typeof globalMaplibre.addProtocol === 'function') {
      modulePromise = Promise.resolve(globalMaplibre);
    } else {
      modulePromise = import('maplibre-gl').then(
        (module) => (module.default ?? module) as unknown as MaplibreModule,
      );
    }
    modulePromise.catch(() => {
      modulePromise = undefined;
    });
  }
  return modulePromise;
}
