# MapLibre GL Vector

A template for creating GeoLibre Desktop plugins backed by MapLibre GL JS controls. It still includes the standalone MapLibre control and React wrapper so plugin authors can develop and test the control outside GeoLibre.

[![npm version](https://img.shields.io/npm/v/maplibre-gl-vector.svg)](https://www.npmjs.com/package/maplibre-gl-vector)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Open in CodeSandbox](https://img.shields.io/badge/Open%20in-CodeSandbox-blue?logo=codesandbox)](https://codesandbox.io/p/github/opengeos/maplibre-gl-vector)
[![Open in StackBlitz](https://img.shields.io/badge/Open%20in-StackBlitz-blue?logo=stackblitz)](https://stackblitz.com/github/opengeos/maplibre-gl-vector)

## Features

- **GeoLibre Bundle Output** - Builds a zip with root `plugin.json`, bundled ESM, and CSS for GeoLibre Desktop
- **TypeScript Support** - Full TypeScript support with type definitions
- **React Integration** - React wrapper component and custom hooks
- **IControl Implementation** - Implements MapLibre's IControl interface
- **Modern Build Setup** - Vite-based library and GeoLibre bundle builds
- **Testing** - Vitest setup with React Testing Library
- **CI/CD Ready** - GitHub Actions for npm publishing and GitHub Pages

## Installation

```bash
npm install maplibre-gl-vector
```

## Build a GeoLibre plugin zip

GeoLibre Desktop loads external plugins from an app data `plugins/` directory. The zip must contain `plugin.json` at the root, plus a bundled ESM entry and optional CSS file.

```bash
npm install
npm run package:geolibre
```

This creates:

```text
geolibre-plugin/maplibre-gl-vector-0.1.0.zip
```

The generated zip contains:

```text
plugin.json
dist/index.js
dist/style.css
```

Copy the zip into GeoLibre Desktop's app data `plugins/` directory and restart GeoLibre. On Linux with the default app identifier, that directory is usually:

```text
~/.local/share/org.geolibre.desktop/plugins/
```

Customize the GeoLibre wrapper in `src/geolibre.ts` and the manifest in `geolibre-plugin/plugin.json`. The manifest `id`, `name`, and `version` must match the exported plugin in `src/geolibre.ts`.

For the GeoLibre web app, serve the unpacked plugin with CORS enabled:

```bash
npm run package:geolibre
npm run serve:geolibre -- 8000
```

Then add this manifest URL in GeoLibre Settings > Plugins:

```text
http://localhost:8000/plugin.json
```

Using `python -m http.server` for this cross-origin web app case is not enough
because it does not send `Access-Control-Allow-Origin`.

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

map.on("load", () => {
  const control = new VectorControl({
    title: "My Plugin",
    collapsed: false,
    panelWidth: 300,
  });

  map.addControl(control, "top-right");
});
```

### React

```tsx
import { useEffect, useRef, useState } from "react";
import maplibregl, { Map } from "maplibre-gl";
import {
  VectorControlReact,
  useVectorState,
} from "maplibre-gl-vector/react";
import "maplibre-gl-vector/style.css";

function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
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
          title="My Plugin"
          collapsed={state.collapsed}
          onStateChange={(newState) => console.log(newState)}
        />
      )}
    </div>
  );
}
```

## API

### VectorControl

The main control class implementing MapLibre's `IControl` interface.

#### Constructor Options

| Option       | Type      | Default            | Description                                                               |
| ------------ | --------- | ------------------ | ------------------------------------------------------------------------- |
| `collapsed`  | `boolean` | `true`             | Whether the panel starts collapsed (showing only the 29x29 toggle button) |
| `position`   | `string`  | `'top-right'`      | Control position on the map                                               |
| `title`      | `string`  | `'Plugin Control'` | Title displayed in the header                                             |
| `panelWidth` | `number`  | `300`              | Width of the dropdown panel in pixels                                     |
| `className`  | `string`  | `''`               | Custom CSS class name                                                     |

#### Methods

- `toggle()` - Toggle the collapsed state
- `expand()` - Expand the panel
- `collapse()` - Collapse the panel
- `getState()` - Get the current state
- `setState(state)` - Update the state
- `on(event, handler)` - Register an event handler
- `off(event, handler)` - Remove an event handler
- `getMap()` - Get the map instance
- `getContainer()` - Get the container element

#### Events

- `collapse` - Fired when the panel is collapsed
- `expand` - Fired when the panel is expanded
- `statechange` - Fired when the state changes

### VectorControlReact

React wrapper component for `VectorControl`.

#### Props

All `VectorControl` options plus:

| Prop            | Type       | Description                         |
| --------------- | ---------- | ----------------------------------- |
| `map`           | `Map`      | MapLibre GL map instance (required) |
| `onStateChange` | `function` | Callback fired when state changes   |

### useVectorState

Custom React hook for managing plugin state.

```typescript
const {
  state, // Current state
  setState, // Update entire state
  setCollapsed, // Set collapsed state
  setPanelWidth, // Set panel width
  setData, // Set custom data
  reset, // Reset to initial state
  toggle, // Toggle collapsed state
} = useVectorState(initialState);
```

## Utilities

The package exports several utility functions:

- `clamp(value, min, max)` - Clamp a value between min and max
- `formatNumericValue(value, step)` - Format a number with appropriate decimals
- `generateId(prefix?)` - Generate a unique ID
- `debounce(fn, delay)` - Debounce a function
- `throttle(fn, limit)` - Throttle a function
- `classNames(classes)` - Build a class string from an object

## Development

### Setup

```bash
# Clone the repository
git clone https://github.com/opengeos/maplibre-gl-vector.git
cd maplibre-gl-vector

# Install dependencies
npm install

# Start development server
npm run dev
```

### Scripts

| Script                     | Description                              |
| -------------------------- | ---------------------------------------- |
| `npm run dev`              | Start development server                 |
| `npm run build`            | Build the library and GeoLibre bundle    |
| `npm run build:lib`        | Build the standalone MapLibre library    |
| `npm run build:geolibre`   | Build the GeoLibre ESM and CSS bundle    |
| `npm run package:geolibre` | Build and zip the GeoLibre plugin bundle |
| `npm run build:examples`   | Build examples for deployment            |
| `npm run test`             | Run tests                                |
| `npm run test:ui`          | Run tests with UI                        |
| `npm run test:coverage`    | Run tests with coverage                  |
| `npm run lint`             | Lint the code                            |
| `npm run format`           | Format the code                          |

### Project Structure

```text
maplibre-gl-vector/
├── geolibre-plugin/
│   └── plugin.json          # GeoLibre external plugin manifest
├── scripts/
│   └── package-geolibre-plugin.mjs
├── src/
│   ├── index.ts              # Main entry point
│   ├── geolibre.ts           # GeoLibre plugin wrapper entry point
│   ├── react.ts              # React entry point
│   ├── index.css             # Root styles
│   └── lib/
│       ├── core/             # Core classes and types
│       ├── hooks/            # React hooks
│       ├── utils/            # Utility functions
│       └── styles/           # Component styles
├── tests/                    # Test files
├── examples/                 # Example applications
│   ├── basic/               # Vanilla JS example
│   └── react/               # React example
└── .github/workflows/        # CI/CD workflows
```

## Docker

The examples can be run using Docker. The image is automatically built and published to GitHub Container Registry.

### Pull and Run

```bash
# Pull the latest image
docker pull ghcr.io/opengeos/maplibre-gl-vector:latest

# Run the container
docker run -p 8080:80 ghcr.io/opengeos/maplibre-gl-vector:latest
```

Then open http://localhost:8080/maplibre-gl-vector/ in your browser to view the examples.

### Build Locally

```bash
# Build the image
docker build -t maplibre-gl-vector .

# Run the container
docker run -p 8080:80 maplibre-gl-vector
```

### Available Tags

| Tag      | Description                      |
| -------- | -------------------------------- |
| `latest` | Latest release                   |
| `x.y.z`  | Specific version (e.g., `1.0.0`) |
| `x.y`    | Minor version (e.g., `1.0`)      |

### Publish to npm

```bash
npm login
npm whoami
npm publish --access public
```

Set up Trusted Publisher on npmjs.com

## Customization

To use this template for your own plugin:

1. Clone or fork this repository
2. Update `package.json` with your plugin name and details
3. Modify `src/lib/core/VectorControl.ts` to implement your plugin logic
4. Update the styles in `src/lib/styles/vector-control.css`
5. Add custom utilities, hooks, or components as needed
6. Update the README with your plugin's documentation

## License

MIT License - see [LICENSE](LICENSE) for details.
