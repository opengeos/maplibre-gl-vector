# GeoLibre Plugin Template

A template for creating GeoLibre Desktop plugins backed by MapLibre GL JS controls. It still includes the standalone MapLibre control and React wrapper so plugin authors can develop and test the control outside GeoLibre.

[![npm version](https://img.shields.io/npm/v/geolibre-plugin-template.svg)](https://www.npmjs.com/package/geolibre-plugin-template)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Open in CodeSandbox](https://img.shields.io/badge/Open%20in-CodeSandbox-blue?logo=codesandbox)](https://codesandbox.io/p/github/opengeos/geolibre-plugin-template)
[![Open in StackBlitz](https://img.shields.io/badge/Open%20in-StackBlitz-blue?logo=stackblitz)](https://stackblitz.com/github/opengeos/geolibre-plugin-template)

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
npm install geolibre-plugin-template
```

## Build a GeoLibre plugin zip

GeoLibre Desktop loads external plugins from an app data `plugins/` directory. The zip must contain `plugin.json` at the root, plus a bundled ESM entry and optional CSS file.

```bash
npm install
npm run package:geolibre
```

This creates:

```text
geolibre-plugin/geolibre-plugin-template-0.1.0.zip
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
import { PluginControl } from "geolibre-plugin-template";
import "geolibre-plugin-template/style.css";

const map = new maplibregl.Map({
  container: "map",
  style: "https://demotiles.maplibre.org/style.json",
  center: [0, 0],
  zoom: 2,
});

map.on("load", () => {
  const control = new PluginControl({
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
  PluginControlReact,
  usePluginState,
} from "geolibre-plugin-template/react";
import "geolibre-plugin-template/style.css";

function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<Map | null>(null);
  const { state, toggle } = usePluginState();

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
        <PluginControlReact
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

### PluginControl

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

### PluginControlReact

React wrapper component for `PluginControl`.

#### Props

All `PluginControl` options plus:

| Prop            | Type       | Description                         |
| --------------- | ---------- | ----------------------------------- |
| `map`           | `Map`      | MapLibre GL map instance (required) |
| `onStateChange` | `function` | Callback fired when state changes   |

### usePluginState

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
} = usePluginState(initialState);
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
git clone https://github.com/your-username/geolibre-plugin-template.git
cd geolibre-plugin-template

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
geolibre-plugin-template/
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
docker pull ghcr.io/opengeos/geolibre-plugin-template:latest

# Run the container
docker run -p 8080:80 ghcr.io/opengeos/geolibre-plugin-template:latest
```

Then open http://localhost:8080/geolibre-plugin-template/ in your browser to view the examples.

### Build Locally

```bash
# Build the image
docker build -t geolibre-plugin-template .

# Run the container
docker run -p 8080:80 geolibre-plugin-template
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
3. Modify `src/lib/core/PluginControl.ts` to implement your plugin logic
4. Update the styles in `src/lib/styles/plugin-control.css`
5. Add custom utilities, hooks, or components as needed
6. Update the README with your plugin's documentation

## License

MIT License - see [LICENSE](LICENSE) for details.
