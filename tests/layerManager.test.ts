import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import { LayerManager, tableNameFor } from '../src/lib/core/LayerManager';
import type { IEngine } from '../src/lib/engine/types';
import { hasTileProvider } from '../src/lib/tiles/protocol';

afterEach(() => {
  vi.unstubAllGlobals();
});

const POLYGON_FC: FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
            [0, 0],
          ],
        ],
      },
      properties: { name: 'box' },
    },
  ],
};

function createMockMap() {
  const sources = new Set<string>();
  const layers = new Set<string>();
  return {
    sources,
    layers,
    addSource: vi.fn((id: string) => sources.add(id)),
    removeSource: vi.fn((id: string) => sources.delete(id)),
    getSource: vi.fn((id: string) => (sources.has(id) ? {} : undefined)),
    addLayer: vi.fn((spec: { id: string }) => layers.add(spec.id)),
    removeLayer: vi.fn((id: string) => layers.delete(id)),
    getLayer: vi.fn((id: string) => (layers.has(id) ? {} : undefined)),
    setLayoutProperty: vi.fn(),
    setPaintProperty: vi.fn(),
    fitBounds: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    getCanvas: vi.fn(() => ({ style: {} })),
  };
}

function createMockEngine(overrides: Partial<IEngine> = {}): IEngine {
  return {
    ingest: vi.fn(async (_source, tableName) => ({
      tableName,
      featureCount: 100,
      bbox: [0, 0, 10, 10] as [number, number, number, number],
      geometryType: 'polygon' as const,
      byteSize: 1234,
    })),
    exportGeoJSON: vi.fn(async () => POLYGON_FC),
    prepareTiles: vi.fn(async () => undefined),
    getTile: vi.fn(async () => new Uint8Array(0)),
    dropTable: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    ...overrides,
  };
}

function createManager(options = {}, engine: IEngine = createMockEngine()) {
  const map = createMockMap();
  const emit = vi.fn();
  const manager = new LayerManager({
    map: map as unknown as MapLibreMap,
    options,
    emit,
    getEngine: async () => engine,
  });
  return { manager, map, emit, engine };
}

describe('tableNameFor', () => {
  it('sanitizes layer ids', () => {
    expect(tableNameFor('vector-abc123')).toBe('t_vector_abc123');
  });
});

describe('LayerManager GeoJSON path', () => {
  it('adds a GeoJSON object without touching the engine', async () => {
    const engine = createMockEngine();
    const { manager, map, emit } = createManager({}, engine);

    const info = await manager.addData(POLYGON_FC, { id: 'poly' });

    expect(info.renderMode).toBe('geojson');
    expect(info.geometryType).toBe('polygon');
    expect(info.featureCount).toBe(1);
    expect(info.bbox).toEqual([0, 0, 10, 10]);
    expect(map.addSource).toHaveBeenCalledWith('poly-source', expect.objectContaining({ type: 'geojson' }));
    // Polygon gets fill + outline layers
    expect(info.layerIds).toEqual(['poly-fill', 'poly-outline']);
    expect(map.fitBounds).toHaveBeenCalled();
    expect(engine.ingest).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('layeradded', expect.objectContaining({ layer: expect.anything() }));
  });

  it('rejects duplicate layer ids', async () => {
    const { manager } = createManager();
    await manager.addData(POLYGON_FC, { id: 'poly' });
    await expect(manager.addData(POLYGON_FC, { id: 'poly' })).rejects.toThrow(/already exists/);
  });

  it('skips fitBounds when disabled', async () => {
    const { manager, map } = createManager();
    await manager.addData(POLYGON_FC, { id: 'poly', fitBounds: false });
    expect(map.fitBounds).not.toHaveBeenCalled();
  });

  it('emits error and rethrows on invalid sources', async () => {
    const { manager, emit } = createManager();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' }),
    );
    await expect(manager.addData('https://x.com/missing.geojson')).rejects.toThrow(/404/);
    expect(emit).toHaveBeenCalledWith('error', expect.objectContaining({ error: expect.any(Error) }));
  });
});

/** Extracts the provider registry key from a duckdb:// tile URL template. */
function providerKeyFromSource(spec: { tiles?: string[] }): string {
  const match = /^duckdb:\/\/([^/]+)\//.exec(spec.tiles?.[0] ?? '');
  return match ? decodeURIComponent(match[1]) : '';
}

describe('LayerManager engine path', () => {
  it('renders small engine data as GeoJSON', async () => {
    const engine = createMockEngine();
    const { manager, map } = createManager({}, engine);
    const file = new File(['x'], 'data.gpkg');

    const info = await manager.addData(file, { id: 'small' });

    expect(engine.ingest).toHaveBeenCalledWith(file, 't_small', expect.objectContaining({ format: 'geopackage' }));
    expect(engine.exportGeoJSON).toHaveBeenCalledWith('t_small');
    expect(info.renderMode).toBe('geojson');
    expect(map.addSource).toHaveBeenCalledWith('small-source', expect.objectContaining({ type: 'geojson' }));
  });

  it('renders large engine data as tiles', async () => {
    const engine = createMockEngine({
      ingest: vi.fn(async (_s, tableName) => ({
        tableName,
        featureCount: 1_000_000,
        bbox: [0, 0, 10, 10] as [number, number, number, number],
        geometryType: 'polygon' as const,
      })),
    });
    const { manager, map } = createManager({}, engine);

    const info = await manager.addData(new File(['x'], 'big.parquet'), { id: 'big' });

    expect(info.renderMode).toBe('tiles');
    expect(engine.prepareTiles).toHaveBeenCalledWith('t_big');
    const sourceSpec = map.addSource.mock.calls.find((c) => c[0] === 'big-source')?.[1] as {
      type: string;
      tiles: string[];
      bounds: number[];
    };
    expect(sourceSpec).toMatchObject({ type: 'vector', bounds: [0, 0, 10, 10] });
    // Tile URL uses a generated provider key, not the public layer id
    expect(sourceSpec.tiles[0]).toMatch(/^duckdb:\/\/big-tiles-[a-z0-9]+\/\{z\}\/\{x\}\/\{y\}$/);
    const providerKey = providerKeyFromSource(sourceSpec);
    expect(hasTileProvider(providerKey)).toBe(true);
    // source-layer must match the layer id used in the tile query
    expect(map.addLayer).toHaveBeenCalledWith(
      expect.objectContaining({ 'source-layer': 'big' }),
      undefined,
    );

    manager.removeLayer('big');
    expect(hasTileProvider(providerKey)).toBe(false);
    // dropTable is fire-and-forget through the async engine provider
    await vi.waitFor(() => expect(engine.dropTable).toHaveBeenCalledWith('t_big'));
  });

  it('honors the per-layer tiles override below thresholds', async () => {
    const engine = createMockEngine();
    const { manager } = createManager({}, engine);
    const info = await manager.addData(new File(['x'], 'small.fgb'), {
      id: 'forced',
      renderMode: 'tiles',
    });
    expect(info.renderMode).toBe('tiles');
    manager.removeLayer('forced');
  });
});

describe('LayerManager layer operations', () => {
  it('toggles visibility', async () => {
    const { manager, map, emit } = createManager();
    await manager.addData(POLYGON_FC, { id: 'poly' });

    manager.setLayerVisibility('poly', false);
    expect(map.setLayoutProperty).toHaveBeenCalledWith('poly-fill', 'visibility', 'none');
    expect(manager.getLayer('poly')?.visible).toBe(false);
    expect(emit).toHaveBeenCalledWith('layerupdated', expect.anything());

    // No-op when unchanged
    map.setLayoutProperty.mockClear();
    manager.setLayerVisibility('poly', false);
    expect(map.setLayoutProperty).not.toHaveBeenCalled();
  });

  it('applies style patches', async () => {
    const { manager, map } = createManager();
    await manager.addData(POLYGON_FC, { id: 'poly' });

    manager.setLayerStyle('poly', { fillColor: '#ff0000' });
    expect(map.setPaintProperty).toHaveBeenCalledWith('poly-fill', 'fill-color', '#ff0000');
    expect(manager.getLayer('poly')?.style.fillColor).toBe('#ff0000');
  });

  it('zooms to a layer', async () => {
    const { manager, map } = createManager();
    await manager.addData(POLYGON_FC, { id: 'poly' });
    map.fitBounds.mockClear();

    manager.zoomToLayer('poly');
    expect(map.fitBounds).toHaveBeenCalledWith(
      [
        [0, 0],
        [10, 10],
      ],
      expect.anything(),
    );
  });

  it('removes layers and sources', async () => {
    const { manager, map, emit } = createManager();
    await manager.addData(POLYGON_FC, { id: 'poly' });

    manager.removeLayer('poly');
    expect(map.removeLayer).toHaveBeenCalledWith('poly-fill');
    expect(map.removeLayer).toHaveBeenCalledWith('poly-outline');
    expect(map.removeSource).toHaveBeenCalledWith('poly-source');
    expect(manager.getLayers()).toHaveLength(0);
    expect(emit).toHaveBeenCalledWith('layerremoved', expect.anything());
  });

  it('switches render mode to tiles and back', async () => {
    const engine = createMockEngine();
    const { manager, map } = createManager({}, engine);
    await manager.addData(POLYGON_FC, { id: 'poly' });
    expect(manager.getLayer('poly')?.renderMode).toBe('geojson');

    await manager.setRenderMode('poly', 'tiles');
    expect(manager.getLayer('poly')?.renderMode).toBe('tiles');
    expect(engine.ingest).toHaveBeenCalled();
    const sourceSpec = map.addSource.mock.calls.find(
      (c) => c[0] === 'poly-source' && (c[1] as { type: string }).type === 'vector',
    )?.[1] as { tiles?: string[] };
    const providerKey = providerKeyFromSource(sourceSpec);
    expect(hasTileProvider(providerKey)).toBe(true);

    await manager.setRenderMode('poly', 'geojson');
    expect(manager.getLayer('poly')?.renderMode).toBe('geojson');
    expect(hasTileProvider(providerKey)).toBe(false);
    expect(engine.exportGeoJSON).toHaveBeenCalled();
    expect(map.addSource).toHaveBeenLastCalledWith(
      'poly-source',
      expect.objectContaining({ type: 'geojson' }),
    );
  });

  it('attaches picker click handlers by default and detaches on remove', async () => {
    const { manager, map } = createManager();
    await manager.addData(POLYGON_FC, { id: 'poly' });
    expect(map.on).toHaveBeenCalledWith('click', 'poly-fill', expect.any(Function));
    expect(map.on).toHaveBeenCalledWith('mouseenter', 'poly-fill', expect.any(Function));

    manager.removeLayer('poly');
    expect(map.off).toHaveBeenCalledWith('click', 'poly-fill', expect.any(Function));
  });

  it('skips picker handlers when disabled', async () => {
    const { manager, map } = createManager({ enablePicker: false });
    await manager.addData(POLYGON_FC, { id: 'poly' });
    expect(map.on).not.toHaveBeenCalledWith('click', 'poly-fill', expect.any(Function));
  });

  it('passes beforeId to addLayer when the target exists', async () => {
    const { manager, map } = createManager({ beforeId: 'labels' });
    map.layers.add('labels');
    await manager.addData(POLYGON_FC, { id: 'poly' });
    expect(map.addLayer).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'poly-fill' }),
      'labels',
    );
  });

  it('ignores beforeId when the target layer is missing', async () => {
    const { manager, map } = createManager({ beforeId: 'missing' });
    await manager.addData(POLYGON_FC, { id: 'poly' });
    expect(map.addLayer).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'poly-fill' }),
      undefined,
    );
  });

  it('disposes without events', async () => {
    const { manager, map, emit } = createManager();
    await manager.addData(POLYGON_FC, { id: 'poly' });
    emit.mockClear();

    manager.dispose();
    expect(map.removeSource).toHaveBeenCalledWith('poly-source');
    expect(manager.getLayers()).toHaveLength(0);
    expect(emit).not.toHaveBeenCalled();
  });
});
