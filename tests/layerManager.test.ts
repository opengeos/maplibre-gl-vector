import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import {
  LayerManager,
  describeSource,
  isLooseShapefileMissingSiblings,
  tableNameFor,
} from '../src/lib/core/LayerManager';
import type { IEngine } from '../src/lib/engine/types';
import { hasTileProvider, loadTile } from '../src/lib/tiles/protocol';

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

const POINT_FC: FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [1, 2] },
      properties: { name: 'dot' },
    },
  ],
};

function createMockMap() {
  const sources = new Map<string, unknown>();
  const layers = new Set<string>();
  return {
    sources,
    layers,
    addSource: vi.fn((id: string, spec?: unknown) => sources.set(id, spec)),
    removeSource: vi.fn((id: string) => sources.delete(id)),
    getSource: vi.fn((id: string) =>
      sources.has(id) ? { serialize: () => sources.get(id) } : undefined,
    ),
    addLayer: vi.fn((spec: { id: string }) => layers.add(spec.id)),
    removeLayer: vi.fn((id: string) => layers.delete(id)),
    getLayer: vi.fn((id: string) => (layers.has(id) ? {} : undefined)),
    setLayoutProperty: vi.fn(),
    setPaintProperty: vi.fn(),
    fitBounds: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    getCanvas: vi.fn(() => ({ style: {} })),
    moveLayer: vi.fn(),
    getStyle: vi.fn(() => ({ layers: [] })),
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
    listLayers: vi.fn(async () => []),
    exportGeoJSON: vi.fn(async () => POLYGON_FC),
    reprojectGeoJSON: vi.fn(async (collection) => collection),
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

describe('describeSource', () => {
  it('describes a URL source', () => {
    expect(describeSource('https://example.com/a.geojson')).toEqual({
      kind: 'url',
      url: 'https://example.com/a.geojson',
    });
  });

  it('describes a File source with its name', () => {
    const file = new File(['{}'], 'cities.gpkg');
    expect(describeSource(file)).toEqual({ kind: 'file', fileName: 'cities.gpkg' });
  });

  it('echoes a sourcePath on a File source when provided', () => {
    const file = new File(['{}'], 'cities.gpkg');
    expect(describeSource(file, '/data/cities.gpkg')).toEqual({
      kind: 'file',
      fileName: 'cities.gpkg',
      path: '/data/cities.gpkg',
    });
  });

  it('echoes a sourcePath on a bare Blob source', () => {
    const blob = new Blob(['{}']);
    expect(describeSource(blob, '/data/cities.gpkg')).toEqual({
      kind: 'file',
      path: '/data/cities.gpkg',
    });
  });

  it('omits a blank sourcePath and ignores it for URL sources', () => {
    const file = new File(['{}'], 'cities.gpkg');
    expect(describeSource(file, '   ')).toEqual({ kind: 'file', fileName: 'cities.gpkg' });
    expect(describeSource('https://example.com/a.geojson', '/data/a.geojson')).toEqual({
      kind: 'url',
      url: 'https://example.com/a.geojson',
    });
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

  it('reprojects a GeoJSON that declares a non-WGS84 crs member', async () => {
    // A projected FeatureCollection (metres) tagged with a legacy `crs` member.
    const projected = {
      type: 'FeatureCollection',
      crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::26911' } },
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [455367, 5278215] },
          properties: { class: 255 },
        },
      ],
    };
    const wgs84 = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-117.59, 47.65] },
          properties: { class: 255 },
        },
      ],
    };
    const engine = createMockEngine({
      reprojectGeoJSON: vi.fn(async () => wgs84 as FeatureCollection),
    });
    const { manager, map } = createManager({}, engine);

    const info = await manager.addData(projected as FeatureCollection, { id: 'utm' });

    // The parsed EPSG code drives the reprojection, and the rendered source is
    // the WGS84 collection (so its bbox is valid lon/lat, not metres).
    expect(engine.reprojectGeoJSON).toHaveBeenCalledWith(projected, 'EPSG:26911');
    expect(info.renderMode).toBe('geojson');
    expect(info.bbox).toEqual([-117.59, 47.65, -117.59, 47.65]);
    expect(map.addSource).toHaveBeenCalledWith(
      'utm-source',
      expect.objectContaining({
        data: expect.objectContaining({
          features: [expect.objectContaining({ geometry: { type: 'Point', coordinates: [-117.59, 47.65] } })],
        }),
      }),
    );
  });

  it('does not reproject a plain WGS84 GeoJSON', async () => {
    const engine = createMockEngine();
    const { manager } = createManager({}, engine);

    await manager.addData(POLYGON_FC, { id: 'poly' });

    expect(engine.reprojectGeoJSON).not.toHaveBeenCalled();
  });

  it('rebuilds the polygon layers when 3D extrusion is toggled', async () => {
    const { manager, map } = createManager();
    const info = await manager.addData(POLYGON_FC, { id: 'poly', fitBounds: false });
    expect(info.layerIds).toEqual(['poly-fill', 'poly-outline']);

    // Turning extrusion on swaps the flat fill/outline for a fill-extrusion
    // layer (a structural change, not a paint patch). The source is untouched.
    map.addSource.mockClear();
    manager.setLayerStyle('poly', { extrusionEnabled: true });
    expect(map.removeLayer).toHaveBeenCalledWith('poly-fill');
    expect(map.removeLayer).toHaveBeenCalledWith('poly-outline');
    expect(map.addLayer).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'poly-extrusion', type: 'fill-extrusion' }),
      undefined,
    );
    expect(map.addSource).not.toHaveBeenCalled();
    expect(manager.getLayers().find((l) => l.id === 'poly')?.layerIds).toEqual([
      'poly-extrusion',
    ]);

    // Turning it back off restores the flat fill/outline pair.
    manager.setLayerStyle('poly', { extrusionEnabled: false });
    expect(map.removeLayer).toHaveBeenCalledWith('poly-extrusion');
    expect(manager.getLayers().find((l) => l.id === 'poly')?.layerIds).toEqual([
      'poly-fill',
      'poly-outline',
    ]);
  });

  it('treats an extrusion color/height restyle as a paint update, not a rebuild', async () => {
    const { manager, map } = createManager();
    await manager.addData(POLYGON_FC, { id: 'poly', fitBounds: false });
    manager.setLayerStyle('poly', { extrusionEnabled: true });
    map.removeLayer.mockClear();
    map.setPaintProperty.mockClear();

    manager.setLayerStyle('poly', { extrusionColor: '#ff0000', extrusionHeight: 12 });
    expect(map.removeLayer).not.toHaveBeenCalled();
    expect(map.setPaintProperty).toHaveBeenCalledWith(
      'poly-extrusion',
      'fill-extrusion-color',
      '#ff0000',
    );
    expect(map.setPaintProperty).toHaveBeenCalledWith('poly-extrusion', 'fill-extrusion-height', 12);
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

  it('rejects a loose .shp without its siblings with an actionable message', async () => {
    const { manager, emit, engine } = createManager();

    await expect(manager.addData(new File(['shp'], 'cities.shp'))).rejects.toThrow(
      /Select the \.shp together with its \.shx and \.dbf/,
    );
    // Fails fast, before any engine work.
    expect(engine.ingest).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ error: expect.any(Error) }),
    );
  });

  it('loads a loose .shp when its .shx and .dbf siblings are provided', async () => {
    const { manager, engine } = createManager();

    await manager.addData(new File(['shp'], 'cities.shp'), {
      id: 'cities',
      companionFiles: [
        new File(['shx'], 'cities.shx'),
        new File(['dbf'], 'cities.dbf'),
      ],
    });

    expect(engine.ingest).toHaveBeenCalled();
  });
});

describe('getLayerGeoJSON', () => {
  it('returns null for an unknown layer id', async () => {
    const { manager } = createManager();
    expect(await manager.getLayerGeoJSON('nope')).toBeNull();
  });

  it('returns the cached collection for a point geojson layer', async () => {
    const { manager, engine } = createManager();
    await manager.addData(POINT_FC, { id: 'dots', fitBounds: false });
    expect(await manager.getLayerGeoJSON('dots')).toEqual(POINT_FC);
    // Cached in memory, so no engine readback.
    expect(engine.exportGeoJSON).not.toHaveBeenCalled();
  });

  it('reads a line/polygon geojson layer back from its map source', async () => {
    const { manager, engine } = createManager();
    await manager.addData(POLYGON_FC, { id: 'poly', fitBounds: false });
    // Polygon geojson keeps no cached copy; it comes from the map source.
    expect(await manager.getLayerGeoJSON('poly')).toEqual(POLYGON_FC);
    expect(engine.exportGeoJSON).not.toHaveBeenCalled();
  });

  it('exports an engine-backed (tiled) layer from its DuckDB table', async () => {
    const { manager, engine } = createManager();
    await manager.addData(new File(['gpkg'], 'cities.gpkg'), {
      id: 'cities',
      renderMode: 'tiles',
      fitBounds: false,
    });
    expect(await manager.getLayerGeoJSON('cities')).toEqual(POLYGON_FC);
    expect(engine.exportGeoJSON).toHaveBeenCalledWith('t_cities');
  });
});

describe('isLooseShapefileMissingSiblings', () => {
  it('flags a lone .shp', () => {
    expect(isLooseShapefileMissingSiblings(new File(['x'], 'a.shp'), {})).toBe(true);
  });

  it('flags a .shp missing either the .shx or the .dbf', () => {
    expect(
      isLooseShapefileMissingSiblings(new File(['x'], 'a.shp'), {
        companionFiles: [new File(['x'], 'a.shx')],
      }),
    ).toBe(true);
    expect(
      isLooseShapefileMissingSiblings(new File(['x'], 'a.shp'), {
        companionFiles: [new File(['x'], 'a.dbf')],
      }),
    ).toBe(true);
  });

  it('does not flag a .shp with both required siblings (case-insensitive)', () => {
    expect(
      isLooseShapefileMissingSiblings(new File(['x'], 'a.shp'), {
        companionFiles: [new File(['x'], 'a.SHX'), new File(['x'], 'a.DBF')],
      }),
    ).toBe(false);
  });

  it('does not flag zipped shapefiles, other files, or non-File sources', () => {
    expect(isLooseShapefileMissingSiblings(new File(['x'], 'a.zip'), {})).toBe(false);
    expect(isLooseShapefileMissingSiblings(new File(['x'], 'a.geojson'), {})).toBe(false);
    expect(isLooseShapefileMissingSiblings('https://x.com/a.shp', {})).toBe(false);
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

  it('passes the ingest mode to the engine and reflects the result', async () => {
    const engine = createMockEngine({
      ingest: vi.fn(async (_s, tableName) => ({
        tableName,
        featureCount: 100,
        bbox: [0, 0, 10, 10] as [number, number, number, number],
        geometryType: 'polygon' as const,
        streamed: true,
      })),
    });
    const { manager } = createManager({}, engine);

    const info = await manager.addData('https://x.com/big.parquet', {
      id: 'streamy',
      ingestMode: 'stream',
    });

    expect(engine.ingest).toHaveBeenCalledWith(
      'https://x.com/big.parquet',
      't_streamy',
      expect.objectContaining({ mode: 'stream' }),
    );
    expect(info.ingestMode).toBe('stream');
  });

  it('falls back to table mode when the engine does not stream', async () => {
    const { manager } = createManager();
    const info = await manager.addData(new File(['x'], 'data.gpkg'), {
      id: 'nostream',
      ingestMode: 'stream',
    });
    // Mock engine reports streamed: undefined -> resolved as table
    expect(info.ingestMode).toBe('table');
  });

  it('expands multi-layer containers into one vector layer per source layer', async () => {
    const engine = createMockEngine({
      listLayers: vi.fn(async () => ['roads', 'buildings']),
    });
    const { manager, map, emit } = createManager({}, engine);

    const info = await manager.addData(new File(['x'], 'city.gpkg'), { id: 'city' });

    expect(engine.listLayers).toHaveBeenCalledWith(
      expect.anything(),
      't_city',
      expect.objectContaining({ format: 'geopackage' }),
    );
    expect(engine.ingest).toHaveBeenCalledWith(
      expect.anything(),
      't_city_roads',
      expect.objectContaining({ sourceLayer: 'roads' }),
    );
    expect(engine.ingest).toHaveBeenCalledWith(
      expect.anything(),
      't_city_buildings',
      expect.objectContaining({ sourceLayer: 'buildings' }),
    );
    expect(manager.getLayers().map((l) => l.id).sort()).toEqual([
      'city-buildings',
      'city-roads',
    ]);
    expect(manager.getLayer('city-roads')?.name).toBe('roads');
    expect(info.id).toBe('city-roads');
    // One combined fitBounds for the whole container
    expect(map.fitBounds).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      'loading',
      expect.objectContaining({ message: expect.stringContaining('2 layers') }),
    );
  });

  it('skips expansion when a sourceLayer is requested', async () => {
    const engine = createMockEngine({
      listLayers: vi.fn(async () => ['roads', 'buildings']),
    });
    const { manager } = createManager({}, engine);

    await manager.addData(new File(['x'], 'city.gpkg'), { id: 'one', sourceLayer: 'roads' });
    expect(engine.listLayers).not.toHaveBeenCalled();
    expect(manager.getLayers()).toHaveLength(1);
  });

  it('reports tile generation progress through loading events', async () => {
    const engine = createMockEngine();
    const { manager, map, emit } = createManager({}, engine);
    await manager.addData(new File(['x'], 'data.fgb'), { id: 'prog', renderMode: 'tiles' });
    const sourceSpec = map.addSource.mock.calls.find((c) => c[0] === 'prog-source')?.[1] as {
      tiles: string[];
    };
    const providerKey = providerKeyFromSource(sourceSpec);
    emit.mockClear();

    await loadTile(`duckdb://${encodeURIComponent(providerKey)}/0/0/0`, new AbortController().signal);
    expect(emit).toHaveBeenCalledWith(
      'loading',
      expect.objectContaining({ message: 'Generating tiles (1 pending)...' }),
    );
    // Status clears shortly after the queue drains
    await vi.waitFor(() =>
      expect(emit).toHaveBeenCalledWith('loading', expect.objectContaining({ message: '' })),
    );
    manager.removeLayer('prog');
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

  it('exposes attribute field names for a GeoJSON layer', async () => {
    const { manager } = createManager();
    const info = await manager.addData(POLYGON_FC, { id: 'poly', fitBounds: false });
    expect(info.fields).toEqual(['name']);
  });

  it('creates a label layer when a layer is added with a labelField', async () => {
    const { manager } = createManager();
    const info = await manager.addData(POLYGON_FC, {
      id: 'poly',
      fitBounds: false,
      style: { labelField: 'name' },
    });
    expect(info.layerIds).toEqual(['poly-fill', 'poly-outline', 'poly-label']);
  });

  it('adds, restyles, and removes the label layer as the labelField changes', async () => {
    const { manager, map } = createManager();
    await manager.addData(POLYGON_FC, { id: 'poly', fitBounds: false });
    expect(manager.getLayer('poly')?.layerIds).not.toContain('poly-label');

    // Setting a labelField adds the symbol layer.
    manager.setLayerStyle('poly', { labelField: 'name' });
    expect(map.addLayer).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'poly-label', type: 'symbol' }),
      undefined,
    );
    expect(manager.getLayer('poly')?.layerIds).toContain('poly-label');
    // The picker is re-wired so the new label layer gets click handlers too.
    expect(map.on).toHaveBeenCalledWith('click', 'poly-label', expect.any(Function));
    expect(map.on).toHaveBeenCalledWith('mouseenter', 'poly-label', expect.any(Function));
    expect(map.on).toHaveBeenCalledWith('mouseleave', 'poly-label', expect.any(Function));

    // A size change updates the symbol layout in place (no rebuild).
    map.addLayer.mockClear();
    manager.setLayerStyle('poly', { labelSize: 20 });
    expect(map.setLayoutProperty).toHaveBeenCalledWith('poly-label', 'text-size', 20);
    expect(map.addLayer).not.toHaveBeenCalled();

    // Clearing the field removes the label layer.
    manager.setLayerStyle('poly', { labelField: '' });
    expect(map.removeLayer).toHaveBeenCalledWith('poly-label');
    expect(manager.getLayer('poly')?.layerIds).not.toContain('poly-label');
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

  it('toggles the picker at runtime', async () => {
    const { manager, map } = createManager();
    await manager.addData(POLYGON_FC, { id: 'poly' });
    expect(manager.getLayer('poly')?.picker).toBe(true);

    manager.setLayerPicker('poly', false);
    expect(manager.getLayer('poly')?.picker).toBe(false);
    expect(map.off).toHaveBeenCalledWith('click', 'poly-fill', expect.any(Function));

    map.on.mockClear();
    manager.setLayerPicker('poly', true);
    expect(map.on).toHaveBeenCalledWith('click', 'poly-fill', expect.any(Function));
  });

  it('moves layers with setLayerBeforeId', async () => {
    const { manager, map } = createManager();
    map.layers.add('labels');
    await manager.addData(POLYGON_FC, { id: 'poly' });

    manager.setLayerBeforeId('poly', 'labels');
    expect(map.moveLayer).toHaveBeenCalledWith('poly-fill', 'labels');
    expect(map.moveLayer).toHaveBeenCalledWith('poly-outline', 'labels');
    expect(manager.getLayer('poly')?.beforeId).toBe('labels');

    manager.setLayerBeforeId('poly', undefined);
    expect(map.moveLayer).toHaveBeenCalledWith('poly-fill', undefined);
    expect(manager.getLayer('poly')?.beforeId).toBeUndefined();
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

  it('describes the data source for persistence', async () => {
    const { manager } = createManager();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify(POLYGON_FC) }),
    );

    const fromUrl = await manager.addData('https://x.com/data.geojson', { id: 'from-url' });
    expect(fromUrl.source).toEqual({ kind: 'url', url: 'https://x.com/data.geojson' });

    const fromFile = await manager.addData(new File(['x'], 'data.gpkg'), { id: 'from-file' });
    expect(fromFile.source).toEqual({ kind: 'file', fileName: 'data.gpkg' });

    const fromObject = await manager.addData(POLYGON_FC, { id: 'from-object' });
    expect(fromObject.source).toEqual({ kind: 'geojson' });
  });

  it('records the sourceLayer of expanded container layers', async () => {
    const engine = createMockEngine({
      listLayers: vi.fn(async () => ['roads', 'buildings']),
    });
    const { manager } = createManager({}, engine);

    await manager.addData(new File(['x'], 'city.gpkg'), { id: 'city' });
    expect(manager.getLayer('city-roads')?.sourceLayer).toBe('roads');
    expect(manager.getLayer('city-buildings')?.sourceLayer).toBe('buildings');
  });

  it('applies an initial master opacity to the created layers', async () => {
    const { manager, map } = createManager();
    const info = await manager.addData(POLYGON_FC, { id: 'poly', opacity: 0.5 });

    expect(info.opacity).toBe(0.5);
    const fillSpec = map.addLayer.mock.calls.find((c) => c[0].id === 'poly-fill')?.[0] as {
      paint: Record<string, number>;
    };
    expect(fillSpec.paint['fill-opacity']).toBe(0.4 * 0.5);
    const outlineSpec = map.addLayer.mock.calls.find((c) => c[0].id === 'poly-outline')?.[0] as {
      paint: Record<string, number>;
    };
    expect(outlineSpec.paint['line-opacity']).toBe(0.5);
  });

  it('updates the master opacity with setLayerOpacity', async () => {
    const { manager, map, emit } = createManager();
    await manager.addData(POLYGON_FC, { id: 'poly' });
    emit.mockClear();

    manager.setLayerOpacity('poly', 0.25);
    expect(manager.getLayer('poly')?.opacity).toBe(0.25);
    expect(map.setPaintProperty).toHaveBeenCalledWith('poly-fill', 'fill-opacity', 0.4 * 0.25);
    expect(map.setPaintProperty).toHaveBeenCalledWith('poly-outline', 'line-opacity', 0.25);
    expect(emit).toHaveBeenCalledWith(
      'layerupdated',
      expect.objectContaining({ layer: expect.objectContaining({ opacity: 0.25 }) }),
    );

    // No-op when the opacity is unchanged
    emit.mockClear();
    manager.setLayerOpacity('poly', 0.25);
    expect(emit).not.toHaveBeenCalled();
  });

  it('keeps the master opacity applied through style patches', async () => {
    const { manager, map } = createManager();
    await manager.addData(POLYGON_FC, { id: 'poly', opacity: 0.5 });

    manager.setLayerStyle('poly', { fillOpacity: 0.8 });
    expect(map.setPaintProperty).toHaveBeenCalledWith('poly-fill', 'fill-opacity', 0.8 * 0.5);
    // The stored style keeps the unscaled value
    expect(manager.getLayer('poly')?.style.fillOpacity).toBe(0.8);
  });
});

describe('LayerManager extensionless URL sniffing', () => {
  /** GeoJSON Response stub for a JSON-typed body. */
  function geojsonResponse() {
    return {
      ok: true,
      status: 200,
      headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'application/geo+json' : null) },
      text: async () => JSON.stringify(POLYGON_FC),
      body: { cancel: vi.fn(async () => undefined) },
    };
  }

  it('loads an extensionless GeoJSON endpoint without the engine, fetching once', async () => {
    const engine = createMockEngine();
    const { manager, map } = createManager({}, engine);
    const fetchMock = vi.fn().mockResolvedValue(geojsonResponse());
    vi.stubGlobal('fetch', fetchMock);

    const info = await manager.addData(
      'https://api.example.com/collections/buildings/items?f=geojson',
      { id: 'ogc' },
    );

    expect(info.format).toBe('geojson');
    expect(info.renderMode).toBe('geojson');
    // Source descriptor stays URL-backed so a host can persist/reload it.
    expect(info.source).toEqual({
      kind: 'url',
      url: 'https://api.example.com/collections/buildings/items?f=geojson',
    });
    expect(engine.ingest).not.toHaveBeenCalled();
    // One GET for the sniff, reused for rendering (no second fetch, no HEAD).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(map.addSource).toHaveBeenCalledWith('ogc-source', expect.objectContaining({ type: 'geojson' }));
  });

  it('falls through to the engine for an extensionless non-JSON endpoint', async () => {
    const engine = createMockEngine();
    const { manager } = createManager({}, engine);
    const fetchMock = vi.fn((_url: string, init?: { method?: string }) => {
      if (init?.method === 'HEAD') {
        return Promise.resolve({ ok: true, headers: { get: () => null } });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => 'application/octet-stream' },
        text: async () => 'PAR1',
        body: { cancel: vi.fn(async () => undefined) },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await manager.addData('https://files.example.com/export?format=parquet', { id: 'bin' });

    expect(engine.ingest).toHaveBeenCalledWith(
      'https://files.example.com/export?format=parquet',
      't_bin',
      expect.anything(),
    );
  });

  it('skips the sniff when tiles are explicitly requested', async () => {
    const engine = createMockEngine({
      ingest: vi.fn(async (_s, tableName) => ({
        tableName,
        featureCount: 1_000_000,
        bbox: [0, 0, 10, 10] as [number, number, number, number],
        geometryType: 'polygon' as const,
      })),
    });
    const { manager } = createManager({}, engine);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, headers: { get: () => null } });
    vi.stubGlobal('fetch', fetchMock);

    const info = await manager.addData('https://api.example.com/items?f=geojson', {
      id: 'tiled',
      renderMode: 'tiles',
    });

    expect(info.renderMode).toBe('tiles');
    expect(engine.ingest).toHaveBeenCalled();
    // No GeoJSON GET sniff; only the engine's HEAD size probe.
    expect(fetchMock).not.toHaveBeenCalledWith(
      'https://api.example.com/items?f=geojson',
      undefined,
    );
  });

  it('skips the sniff when an explicit format is given', async () => {
    const engine = createMockEngine();
    const { manager } = createManager({}, engine);
    const fetchMock = vi.fn((_url: string, init?: { method?: string }) =>
      Promise.resolve(
        init?.method === 'HEAD'
          ? { ok: true, headers: { get: () => null } }
          : { ok: true, status: 200, headers: { get: () => null }, text: async () => '', body: { cancel: vi.fn() } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await manager.addData('https://api.example.com/items', { id: 'forced', format: 'geoparquet' });

    expect(engine.ingest).toHaveBeenCalledWith(
      'https://api.example.com/items',
      't_forced',
      expect.objectContaining({ format: 'geoparquet' }),
    );
  });
});

describe('LayerManager reloadLayer', () => {
  function fcWithFeatures(count: number): FeatureCollection {
    return {
      type: 'FeatureCollection',
      features: Array.from({ length: count }, () => ({
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
        properties: {},
      })),
    };
  }

  it('re-fetches a URL layer and re-renders it in place', async () => {
    const { manager, map, emit } = createManager();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify(fcWithFeatures(1)),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify(fcWithFeatures(3)),
      });
    vi.stubGlobal('fetch', fetchMock);

    const added = await manager.addData('https://x.com/data.geojson', { id: 'live' });
    expect(added.featureCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const reloaded = await manager.reloadLayer('live');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(reloaded?.id).toBe('live');
    expect(reloaded?.sourceId).toBe('live-source');
    expect(reloaded?.featureCount).toBe(3);
    expect(map.removeSource).toHaveBeenCalledWith('live-source');
    expect(map.addSource).toHaveBeenLastCalledWith(
      'live-source',
      expect.objectContaining({ type: 'geojson' }),
    );
    expect(emit).toHaveBeenCalledWith(
      'layerupdated',
      expect.objectContaining({ layer: expect.objectContaining({ id: 'live' }) }),
    );
  });

  it('returns undefined for an unknown layer id', async () => {
    const { manager } = createManager();
    await expect(manager.reloadLayer('nope')).resolves.toBeUndefined();
  });

  it('does not re-fetch a non-URL (in-memory GeoJSON) layer', async () => {
    const { manager } = createManager();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await manager.addData(POLYGON_FC, { id: 'static' });
    const result = await manager.reloadLayer('static');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result?.id).toBe('static');
  });

  it('re-ingests, re-prepares tiles, and drops the stale table when reloading an engine-backed URL layer', async () => {
    const engine = createMockEngine();
    const { manager } = createManager({}, engine);

    await manager.addData('https://x.com/data.parquet', { id: 'eng', renderMode: 'tiles' });
    expect(engine.ingest).toHaveBeenCalledTimes(1);
    expect(engine.prepareTiles).toHaveBeenCalledTimes(1);

    const reloaded = await manager.reloadLayer('eng');

    expect(reloaded?.renderMode).toBe('tiles');
    expect(engine.ingest).toHaveBeenCalledTimes(2);
    expect(engine.prepareTiles).toHaveBeenCalledTimes(2);
    expect(engine.dropTable).toHaveBeenCalledWith('t_eng');
  });
});
