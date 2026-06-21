# maplibre-gl-vector

A MapLibre GL JS plugin for visualizing vector data in many formats - GeoJSON, GeoPackage, Shapefile, GeoParquet, FlatGeobuf, CSV - powered by [DuckDB-WASM](https://github.com/duckdb/duckdb-wasm) and its [spatial extension](https://duckdb.org/docs/stable/core_extensions/spatial/overview).

[![npm version](https://img.shields.io/npm/v/maplibre-gl-vector.svg)](https://www.npmjs.com/package/maplibre-gl-vector)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Open in CodeSandbox](https://img.shields.io/badge/Open%20in-CodeSandbox-blue?logo=codesandbox)](https://codesandbox.io/p/github/opengeos/maplibre-gl-vector)
[![Open in StackBlitz](https://img.shields.io/badge/Open%20in-StackBlitz-blue?logo=stackblitz)](https://stackblitz.com/github/opengeos/maplibre-gl-vector)

## Features

- **Many vector formats** - GeoJSON, GeoPackage, Shapefile (zipped), GeoParquet, FlatGeobuf, CSV (WKT or lon/lat columns), and every other format the spatial extension's GDAL build reads (KML, GML, MapInfo TAB, DXF, ...)
- **Small data → GeoJSON** - small datasets are converted to GeoJSON and rendered with a `geojson` source
- **Large data → dynamic tiles** - large datasets are rendered as MVT tiles generated client-side by DuckDB per `z/x/y`, served through a `duckdb://` protocol handler ([reference approach](https://gist.github.com/Maxxen/37e4a9f8595ea5e6a20c0c8fbbefe955))
- **Auto mode with override** - render mode is picked automatically from configurable feature-count/byte-size thresholds, with per-layer and UI overrides
- **Lazy DuckDB loading** - DuckDB-WASM (~15-25 MB gzipped) is loaded from the jsDelivr CDN only when a non-GeoJSON format or tile rendering is first requested; GeoJSON-only usage never downloads it
- **Collapsible panel UI** - 29x29 toggle button matching MapLibre controls, with drag-and-drop file upload, URL loading, a layer list (visibility / zoom / remove), a per-layer style editor (colors, render mode, popup toggle, layer placement), dark mode support, and viewport-aware scrolling on small screens
- **Attribute picker** - clicking a feature opens a popup with its attributes (`enablePicker`, on by default)
- **Programmatic API** - `addData()`, `removeLayer()`, `setLayerStyle()`, `setRenderMode()`, events, and more
- **React support** - `VectorControlReact` wrapper and `useVectorState` hook
- **GeoLibre plugin bundle** - builds a zip loadable by GeoLibre Desktop

## Installation

```bash
npm install maplibre-gl-vector
```

## Quick Start

### Vanilla JavaScript/TypeScript

```typescript
import maplibregl from "maplibre-gl";
import { VectorControl } from "maplibre-gl-vector";
import "maplibre-gl-vector/style.css";

const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/positron",
  center: [0, 0],
  zoom: 2,
});

map.on("load", async () => {
  const control = new VectorControl({ collapsed: false });
  map.addControl(control, "top-right");

  // GeoJSON renders without DuckDB
  await control.addData("https://example.com/data.geojson");

  // Other formats load DuckDB-WASM from the CDN on first use
  await control.addData("https://example.com/buildings.parquet");

  // Force dynamic tiles for a large dataset
  await control.addData("https://example.com/roads.gpkg", {
    renderMode: "tiles",
  });
});
```

### React

```tsx
import { useEffect, useRef, useState } from "react";
import maplibregl, { Map } from "maplibre-gl";
import { VectorControlReact, useVectorState } from "maplibre-gl-vector/react";
import type { VectorControl } from "maplibre-gl-vector";
import "maplibre-gl-vector/style.css";

function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const controlRef = useRef<VectorControl | null>(null);
  const [map, setMap] = useState<Map | null>(null);
  const { state, toggle } = useVectorState();

  useEffect(() => {
    if (!mapContainer.current) return;
    const mapInstance = new maplibregl.Map({
      container: mapContainer.current,
      style: "https://tiles.openfreemap.org/styles/positron",
      center: [0, 0],
      zoom: 2,
    });
    mapInstance.on("load", () => setMap(mapInstance));
    return () => mapInstance.remove();
  }, []);

  return (
    <div style={{ width: "100%", height: "100vh" }}>
      <div ref={mapContainer} style={{ width: "100%", height: "100%" }} />
      {map && (
        <VectorControlReact
          map={map}
          controlRef={controlRef}
          collapsed={state.collapsed}
          onLayerAdded={(layer) => console.log("added", layer.name)}
          onError={(error) => console.error(error)}
        />
      )}
      <button onClick={() => controlRef.current?.addData("data.parquet")}>
        Load data
      </button>
    </div>
  );
}
```

## How it works

```text
addData(url | File | GeoJSON)
  ├─ .geojson / GeoJSON object ──→ parsed in JS ──→ geojson source   (no DuckDB)
  └─ .gpkg / .zip / .parquet / .fgb / .csv
       └─ DuckDB-WASM + spatial (lazy-loaded from jsDelivr)
            ├─ small (≤ thresholds) ──→ ST_AsGeoJSON ──→ geojson source
            └─ large (> thresholds) ──→ ST_AsMVT per z/x/y tile
                                         └─ vector source: duckdb://{id}/{z}/{x}/{y}
```

For tile rendering, the data is transformed once to EPSG:3857 (`ST_Transform`), indexed with an R-Tree, and each tile request runs:

```sql
SELECT ST_AsMVT({geometry: ST_AsMVTGeom(geom_3857, ST_Extent(ST_TileEnvelope(z, x, y))), ...}, 'layer')
FROM data
WHERE ST_Intersects(geom_3857, ST_TileEnvelope(z, x, y));
```

On DuckDB builds without `ST_AsMVT`, the plugin falls back to encoding tiles in JavaScript with `geojson-vt` + `vt-pbf` (also lazy-loaded).

### Streaming large GeoParquet

By default a dataset is **materialized** into an in-memory DuckDB table (plus an EPSG:3857 column and R-Tree index in tiles mode) - fastest per-tile queries, but peak memory roughly equals the dataset size. For large GeoParquet you can instead **stream it in place**:

```typescript
await control.addData("https://example.com/buildings.parquet", {
  ingestMode: "stream",
  renderMode: "tiles",
});
```

(or check **"Stream GeoParquet (no copy)"** in the panel before loading)

In streaming mode the file is wrapped in a view and queried directly - nothing is copied into the database. Remote files are read with **HTTP range requests**, and when the file has a GeoParquet 1.1 bbox covering column (named `bbox` or anything ending in `_bbox`, e.g. `geometry_bbox`), the per-tile filter is pushed into parquet row-group statistics so only the row groups intersecting each tile are downloaded. The layer summary (count/extent) also comes from the bbox stats instead of a geometry scan.

Trade-offs: each tile re-reads and reprojects matching rows (slower than the indexed table), and files without a bbox covering column or spatial ordering fall back to scanning per tile. Streaming applies to GeoParquet only; other formats ignore the option and materialize.

**Remote file size limit:** DuckDB-WASM cannot open remote files of **2 GiB or larger** (its HTTP filesystem handles sizes as 32-bit values). The control probes the size with a HEAD request and reports a clear error; split larger datasets into partitions under 2 GiB.

**Spatial ordering matters.** Row-group pruning only helps when nearby features share row groups. In testing with a 205 MB / 6.5M-feature global grid, the row-major (unsorted) file took 30-90 s per tile, while the same data Hilbert-sorted with small row groups served tiles in 60-400 ms. Sort with DuckDB:

```sql
INSTALL spatial; LOAD spatial;
COPY (
  SELECT * FROM 'input.parquet'
  ORDER BY ST_Hilbert(geometry, ST_Extent(ST_MakeEnvelope(-180, -90, 180, 90)))
) TO 'sorted.parquet' (FORMAT PARQUET, COMPRESSION 'zstd', ROW_GROUP_SIZE 30000);
```

The example hardcodes global WGS84 bounds because that dataset is global; for regional data, derive the Hilbert bounds from the data itself:

```sql
COPY (
  WITH b AS (SELECT ST_Extent(ST_Extent_Agg(geometry)) AS box FROM 'input.parquet')
  SELECT * FROM 'input.parquet'
  ORDER BY ST_Hilbert(geometry, (SELECT box FROM b))
) TO 'sorted.parquet' (FORMAT PARQUET, COMPRESSION 'zstd', ROW_GROUP_SIZE 30000);
```

Keep row groups small (20k-50k rows) so pruning stays fine-grained, and prefer `COMPRESSION 'zstd'` - it decompresses fast and shrinks the ranges each tile downloads. The bbox covering column is carried through unchanged. (GeoPandas alternative: sort by `gdf.hilbert_distance()` and write with `to_parquet(write_covering_bbox=True, compression='zstd', row_group_size=30000)`.)

### Size thresholds

In the default `'auto'` render mode, a dataset is rendered as **dynamic tiles** when it exceeds **50,000 features** or **25 MB** (whichever trips first); otherwise it is converted to GeoJSON. Both limits are configurable, and a per-layer `renderMode` always wins:

```typescript
const control = new VectorControl({
  // Switch to tiles above 10k features or 5 MB
  autoThreshold: { featureCount: 10_000, byteSize: 5 * 1024 * 1024 },
});

// Or bypass the thresholds for one layer
await control.addData(url, { renderMode: "tiles" });
```

## Supported formats

| Format | Extensions | Reader | Local files | URLs |
| --- | --- | --- | --- | --- |
| GeoJSON | `.geojson`, `.json` | Pure JS (or `ST_Read` in tiles mode) | ✅ | ✅ |
| GeoParquet | `.parquet`, `.geoparquet`, `.pq` | `read_parquet` (HTTP range reads) | ✅ | ✅ |
| GeoPackage | `.gpkg` | `ST_Read` (GDAL) | ✅ | ✅ |
| Shapefile | `.zip` (zipped), `.shp` | `ST_Read` (GDAL, `/vsizip/`) | ✅ | ✅ |
| FlatGeobuf | `.fgb` | `ST_Read` (GDAL) | ✅ | ✅ |
| CSV | `.csv`, `.tsv` | `read_csv` + WKT or lon/lat columns | ✅ | ✅ |
| Anything GDAL reads | `.kml`, `.gml`, `.tab`, `.dxf`, ... | `ST_Read` (GDAL) | ✅ | ✅ |

Extensions without a dedicated reader are passed straight to `ST_Read`, so any vector format the spatial extension's GDAL build supports will load. Remote URLs must be served with CORS enabled.

### Multi-layer datasets

Containers that hold several layers (a GeoPackage with multiple tables, KML folders, GML/DXF layers, ...) are expanded automatically: the control enumerates the layers with `ST_Read_Meta` and adds **one vector layer per source layer**, each with its own panel entry, visibility toggle, and style. The map zooms once to the combined extent, and the underlying file is registered with DuckDB only once.

To load just one layer from a container, pass `sourceLayer`:

```typescript
await control.addData("city.gpkg", { sourceLayer: "roads" });
```

Single-layer formats (GeoJSON, GeoParquet, CSV) skip the enumeration entirely. CSV files need either a WKT column (`geometry`, `wkt`, `geom`, `the_geom`, `wkb_geometry`) or lon/lat columns (`longitude`/`latitude`, `lon`/`lat`, `lng`/`lat`, `x`/`y`).

### Self-hosting DuckDB-WASM

By default the plugin loads DuckDB-WASM from `cdn.jsdelivr.net` on first use. If you serve the app with a Content-Security-Policy, that requires allowing `https://cdn.jsdelivr.net` in `script-src` (the engine is loaded via a dynamic `import()`); if the CDN is blocked or unreachable, loading fails with `Failed to fetch dynamically imported module`.

To avoid the CDN entirely, mirror the pinned duckdb-wasm assets onto your own origin and point the control at them with `duckdbWasmBaseUrl`:

```typescript
new VectorControl({
  // Serves /+esm and /dist/* just like jsDelivr, from your origin
  duckdbWasmBaseUrl: "/vendor/duckdb-wasm-1.31.0",
});
```

The base must mirror jsDelivr's layout for the pinned version (currently `1.31.0`): an `/+esm` ES-module bundle plus the `/dist/*.wasm` and worker files. The simplest way is to copy the files from `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.31.0/` (including the `+esm` bundle) into a directory your server hosts. The version is pinned deliberately because its DuckDB core ships `ST_AsMVT`; do not substitute a different version.

## API

### VectorControl

#### Constructor Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `collapsed` | `boolean` | `true` | Whether the panel starts collapsed (showing only the 29x29 toggle button) |
| `position` | `string` | `'top-right'` | Control position on the map |
| `title` | `string` | `'Vector Data'` | Title displayed in the header |
| `panelWidth` | `number` | `320` | Width of the dropdown panel in pixels |
| `className` | `string` | `''` | Custom CSS class name |
| `autoThreshold` | `{ featureCount?, byteSize? }` | `{ featureCount: 50000, byteSize: 25 MB }` | Thresholds that switch `'auto'` mode to tiles |
| `defaultRenderMode` | `'auto' \| 'geojson' \| 'tiles'` | `'auto'` | Default render mode for new layers |
| `maxTileZoom` | `number` | `16` | Maximum zoom for dynamic tile generation |
| `attribution` | `string` | - | Attribution attached to created sources |
| `beforeId` | `string` | - | Existing map layer id new layers are inserted before (e.g. a label layer) |
| `enablePicker` | `boolean` | `true` | Click a feature to open a popup with its attributes |
| `defaultIngestMode` | `'table' \| 'stream'` | `'table'` | Materialize into DuckDB or stream GeoParquet in place |
| `urlPlaceholder` | `string` | `'https://example.com/data.parquet'` | Placeholder text for the panel's URL input |
| `defaultUrl` | `string` | - | Initial value of the panel's URL input (a ready-to-load sample dataset) |
| `autoLoad` | `boolean` | `false` | Load `defaultUrl` automatically when the control is added to the map |
| `closeOnOutsideClick` | `boolean` | `true` | Collapse the panel when clicking outside it; set `false` to close only via the header button |
| `resizable` | `boolean` | `false` | Show bottom-left and bottom-right drag handles so the panel can be resized |
| `sampleData` | `VectorSampleDataset[]` | - | Sample datasets shown as a "Load sample data" dropdown below the URL input; picking one fills the input and loads it (hidden when empty) |
| `sampleDataLabel` | `string` | `'Load sample data...'` | Placeholder shown in the sample-data dropdown |
| `duckdbWasmBaseUrl` | `string` | jsDelivr | Base URL to load DuckDB-WASM from instead of the CDN (see [Self-hosting DuckDB-WASM](#self-hosting-duckdb-wasm)) |

#### Data Methods

- `addData(source, options?)` - Load a URL, `File`/`Blob`, or GeoJSON object; resolves with the layer's `VectorLayerInfo`
- `removeLayer(id)` / `removeAll()` - Remove layers
- `getLayers()` / `getLayer(id)` - Layer metadata
- `setLayerVisibility(id, visible)` - Show/hide a layer
- `zoomToLayer(id)` - Fit the map to a layer's extent
- `setLayerStyle(id, style)` - Update colors, opacity, line width, circle radius
- `setLayerOpacity(id, opacity)` - Master opacity (0-1) multiplied into every style opacity
- `setRenderMode(id, mode)` - Switch between `'geojson'` and `'tiles'`
- `reloadLayer(id)` - Re-fetch a URL-backed layer and re-render it in place (keeps the same id, style, and position; no-op for File/GeoJSON-object sources)
- `setLayerPicker(id, enabled)` - Toggle the attribute popup (also a "Popup" checkbox in the panel)
- `setLayerBeforeId(id, beforeId?)` - Move the layer before another map layer, or to the top (also a "Before" select in the panel)

#### Layer Options (`addData`)

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `id` | `string` | auto | Unique layer id |
| `name` | `string` | file name | Display name |
| `renderMode` | `'auto' \| 'geojson' \| 'tiles'` | `'auto'` | Per-layer render mode |
| `visible` | `boolean` | `true` | Initial visibility |
| `opacity` | `number` | `1` | Initial master opacity (0-1) multiplied into every style opacity |
| `fitBounds` | `boolean` | `true` | Zoom to the layer after loading |
| `style` | `Partial<VectorLayerStyle>` | defaults | Initial style overrides |
| `sourceLayer` | `string` | all layers | Load only this layer from a multi-layer container (default expands every layer) |
| `format` | `VectorFormat` | detected | Explicit format override |
| `beforeId` | `string` | control option | Map layer id this layer is inserted before |
| `picker` | `boolean` | control option | Attribute popup on feature click |
| `ingestMode` | `'table' \| 'stream'` | control option | Stream GeoParquet in place instead of copying it into DuckDB |

#### Panel Methods

- `toggle()` / `expand()` / `collapse()` - Panel visibility
- `getState()` / `setState(state)` - Control state (includes `layers`)
- `on(event, handler)` / `off(event, handler)` - Event handlers

#### Events

- `layeradded`, `layerremoved`, `layerupdated` - Layer lifecycle (payload includes `layer`)
- `loading` - Progress messages (payload includes `message`)
- `error` - Loading failures (payload includes `error`)
- `collapse`, `expand`, `statechange` - Panel state

### VectorControlReact

All `VectorControl` options plus:

| Prop | Type | Description |
| --- | --- | --- |
| `map` | `Map` | MapLibre GL map instance (required) |
| `controlRef` | `Ref<VectorControl>` | Receives the control instance for programmatic use |
| `onStateChange` | `function` | Fired when the state changes |
| `onLayerAdded` / `onLayerRemoved` | `function` | Layer lifecycle callbacks |
| `onError` | `function` | Loading failure callback |

### useVectorState

```typescript
const {
  state, // { collapsed, panelWidth, layers, data }
  setState, // Update entire state
  setCollapsed, // Set collapsed state
  setPanelWidth, // Set panel width
  setData, // Set custom data
  reset, // Reset to initial state
  toggle, // Toggle collapsed state
} = useVectorState(initialState);
```

## DuckDB-WASM notes

- DuckDB-WASM is pinned to a version whose core is **DuckDB ≥ 1.4** (the first with `ST_AsMVT`). The plugin probes the capability at startup and falls back to JS tile encoding when missing.
- The WASM bundles (~15-25 MB gzipped) and the spatial extension are fetched from `cdn.jsdelivr.net` and `extensions.duckdb.org` on first use. The panel shows loading progress.
- Remote GeoParquet is read with HTTP range requests - only the needed row groups are downloaded.
- All queries (ingestion and tile generation) run on a single connection through a serialized queue; aborted tile requests (fast panning) are skipped before execution.

## Build a GeoLibre plugin zip

GeoLibre Desktop loads external plugins from an app data `plugins/` directory. The zip must contain `plugin.json` at the root, plus a bundled ESM entry and optional CSS file.

```bash
npm install
npm run package:geolibre
```

This creates `geolibre-plugin/maplibre-gl-vector-0.1.0.zip`. Copy it into GeoLibre Desktop's app data `plugins/` directory and restart GeoLibre. On Linux with the default app identifier:

```text
~/.local/share/org.geolibre.desktop/plugins/
```

For the GeoLibre web app, serve the unpacked plugin with CORS enabled:

```bash
npm run package:geolibre
npm run serve:geolibre -- 8000
```

Then add `http://localhost:8000/plugin.json` in GeoLibre Settings > Plugins.

## Development

### Setup

```bash
git clone https://github.com/opengeos/maplibre-gl-vector.git
cd maplibre-gl-vector
npm install
npm run dev
```

### Scripts

| Script | Description |
| --- | --- |
| `npm run dev` | Start development server |
| `npm run build` | Build the library and GeoLibre bundle |
| `npm run build:lib` | Build the standalone MapLibre library |
| `npm run build:geolibre` | Build the GeoLibre ESM and CSS bundle |
| `npm run package:geolibre` | Build and zip the GeoLibre plugin bundle |
| `npm run build:examples` | Build examples for deployment |
| `npm run test` | Run tests |
| `npm run test:ui` | Run tests with UI |
| `npm run test:coverage` | Run tests with coverage |
| `npm run lint` | Lint the code |
| `npm run format` | Format the code |

### Project Structure

```text
maplibre-gl-vector/
├── geolibre-plugin/
│   └── plugin.json           # GeoLibre external plugin manifest
├── scripts/                  # Packaging/serving helpers
├── src/
│   ├── index.ts              # Main entry point
│   ├── geolibre.ts           # GeoLibre plugin wrapper entry point
│   ├── react.ts              # React entry point
│   ├── index.css             # Root styles
│   └── lib/
│       ├── core/             # VectorControl, LayerManager, types
│       ├── engine/           # DuckDB-WASM loader, engine, SQL builders
│       ├── formats/          # Format detection
│       ├── tiles/            # duckdb:// protocol, MVT fallback
│       ├── render/           # Render mode, sources/layers, styling
│       ├── ui/               # Panel UI (vanilla DOM)
│       ├── hooks/            # React hooks
│       ├── utils/            # Utility functions
│       └── styles/           # Component styles
├── tests/                    # Vitest unit tests
├── examples/                 # Example applications
│   ├── basic/                # Vanilla TS example
│   ├── react/                # React example
│   └── data/                 # Small sample data
└── .github/workflows/        # CI/CD workflows
```

## Docker

The examples can be run using Docker. The image is automatically built and published to GitHub Container Registry.

```bash
docker pull ghcr.io/opengeos/maplibre-gl-vector:latest
docker run -p 8080:80 ghcr.io/opengeos/maplibre-gl-vector:latest
```

Then open http://localhost:8080/maplibre-gl-vector/ in your browser to view the examples.

### Build Locally

```bash
docker build -t maplibre-gl-vector .
docker run -p 8080:80 maplibre-gl-vector
```

## Acknowledgements

- Dynamic tile approach based on [Max Gabrielsson's DuckDB vector tile server gist](https://gist.github.com/Maxxen/37e4a9f8595ea5e6a20c0c8fbbefe955)
- Client-side MVT generation pattern validated by [rot1024/duckdb-wasm-mvt](https://github.com/rot1024/duckdb-wasm-mvt)
- Sample datasets from [opengeos/datasets](https://github.com/opengeos/datasets)

## License

MIT License - see [LICENSE](LICENSE) for details.
