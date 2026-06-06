# maplibre-gl-vector

A MapLibre GL JS plugin for visualizing vector data in many formats - GeoJSON, GeoPackage, Shapefile, GeoParquet, FlatGeobuf, CSV - powered by [DuckDB-WASM](https://github.com/duckdb/duckdb-wasm) and its [spatial extension](https://duckdb.org/docs/stable/core_extensions/spatial/overview).

[![npm version](https://img.shields.io/npm/v/maplibre-gl-vector.svg)](https://www.npmjs.com/package/maplibre-gl-vector)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Open in CodeSandbox](https://img.shields.io/badge/Open%20in-CodeSandbox-blue?logo=codesandbox)](https://codesandbox.io/p/github/opengeos/maplibre-gl-vector)
[![Open in StackBlitz](https://img.shields.io/badge/Open%20in-StackBlitz-blue?logo=stackblitz)](https://stackblitz.com/github/opengeos/maplibre-gl-vector)

## Features

- **Many vector formats** - GeoJSON, GeoPackage, Shapefile (zipped), GeoParquet, FlatGeobuf, and CSV (WKT or lon/lat columns)
- **Small data → GeoJSON** - small datasets are converted to GeoJSON and rendered with a `geojson` source
- **Large data → dynamic tiles** - large datasets are rendered as MVT tiles generated client-side by DuckDB per `z/x/y`, served through a `duckdb://` protocol handler ([reference approach](https://gist.github.com/Maxxen/37e4a9f8595ea5e6a20c0c8fbbefe955))
- **Auto mode with override** - render mode is picked automatically from configurable feature-count/byte-size thresholds, with per-layer and UI overrides
- **Lazy DuckDB loading** - DuckDB-WASM (~15-25 MB gzipped) is loaded from the jsDelivr CDN only when a non-GeoJSON format or tile rendering is first requested; GeoJSON-only usage never downloads it
- **Collapsible panel UI** - 29x29 toggle button matching MapLibre controls, with drag-and-drop file upload, URL loading, a layer list (visibility / zoom / remove), and a per-layer style editor
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
  style: "https://demotiles.maplibre.org/style.json",
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
      style: "https://demotiles.maplibre.org/style.json",
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

## Supported formats

| Format | Extensions | Reader | Local files | URLs |
| --- | --- | --- | --- | --- |
| GeoJSON | `.geojson`, `.json` | Pure JS (or `ST_Read` in tiles mode) | ✅ | ✅ |
| GeoParquet | `.parquet`, `.geoparquet`, `.pq` | `read_parquet` (HTTP range reads) | ✅ | ✅ |
| GeoPackage | `.gpkg` | `ST_Read` (GDAL) | ✅ | ✅ |
| Shapefile | `.zip` (zipped), `.shp` | `ST_Read` (GDAL, `/vsizip/`) | ✅ | ✅ |
| FlatGeobuf | `.fgb` | `ST_Read` (GDAL) | ✅ | ✅ |
| CSV | `.csv`, `.tsv` | `read_csv` + WKT or lon/lat columns | ✅ | ✅ |

Remote URLs must be served with CORS enabled. CSV files need either a WKT column (`geometry`, `wkt`, `geom`, `the_geom`, `wkb_geometry`) or lon/lat columns (`longitude`/`latitude`, `lon`/`lat`, `lng`/`lat`, `x`/`y`).

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

#### Data Methods

- `addData(source, options?)` - Load a URL, `File`/`Blob`, or GeoJSON object; resolves with the layer's `VectorLayerInfo`
- `removeLayer(id)` / `removeAll()` - Remove layers
- `getLayers()` / `getLayer(id)` - Layer metadata
- `setLayerVisibility(id, visible)` - Show/hide a layer
- `zoomToLayer(id)` - Fit the map to a layer's extent
- `setLayerStyle(id, style)` - Update colors, opacity, line width, circle radius
- `setRenderMode(id, mode)` - Switch between `'geojson'` and `'tiles'`

#### Layer Options (`addData`)

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `id` | `string` | auto | Unique layer id |
| `name` | `string` | file name | Display name |
| `renderMode` | `'auto' \| 'geojson' \| 'tiles'` | `'auto'` | Per-layer render mode |
| `visible` | `boolean` | `true` | Initial visibility |
| `fitBounds` | `boolean` | `true` | Zoom to the layer after loading |
| `style` | `Partial<VectorLayerStyle>` | defaults | Initial style overrides |
| `sourceLayer` | `string` | first layer | Layer name inside multi-layer containers (e.g. GeoPackage) |
| `format` | `VectorFormat` | detected | Explicit format override |

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
