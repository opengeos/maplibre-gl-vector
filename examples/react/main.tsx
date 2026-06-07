import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import maplibregl, { Map } from 'maplibre-gl';
import { VectorControlReact, useVectorState } from '../../src/react';
import type { VectorControl } from '../../src/index';
import '../../src/index.css';
import 'maplibre-gl/dist/maplibre-gl.css';

// Sample datasets (CORS-friendly GitHub release assets)
const SAMPLES: Array<{ label: string; url: string; name: string }> = [
  {
    label: 'GeoJSON',
    url: new URL('../data/sample.geojson', import.meta.url).href,
    name: 'Tahoe sample',
  },
  {
    label: 'GeoParquet',
    url: 'https://raw.githubusercontent.com/opengeos/data/main/duckdb/countries.parquet',
    name: 'Countries',
  },
  {
    label: 'GeoPackage',
    url: 'https://raw.githubusercontent.com/opengeos/data/main/us/us_regions.gpkg',
    name: 'US regions',
  },
  {
    label: 'CSV',
    url: 'https://raw.githubusercontent.com/opengeos/data/main/world/world_cities.csv',
    name: 'World cities',
  },
];

/**
 * Main App component demonstrating the React integration
 */
function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const controlRef = useRef<VectorControl | null>(null);
  const [map, setMap] = useState<Map | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { state, toggle, setState } = useVectorState({ collapsed: false });

  // Initialize the map
  useEffect(() => {
    if (!mapContainer.current) return;

    const mapInstance = new maplibregl.Map({
      container: mapContainer.current,
      style: 'https://demotiles.maplibre.org/style.json',
      center: [-98, 39],
      zoom: 3,
    });

    // Add navigation controls to top-right
    mapInstance.addControl(new maplibregl.NavigationControl(), 'top-right');

    // Add fullscreen control to top-right (after navigation)
    mapInstance.addControl(new maplibregl.FullscreenControl(), 'top-right');

    mapInstance.on('load', () => {
      setMap(mapInstance);
    });

    return () => {
      mapInstance.remove();
    };
  }, []);

  const loadSample = (sample: (typeof SAMPLES)[number]) => {
    const control = controlRef.current;
    if (!control) return;
    setBusy(sample.label);
    void control
      .addData(sample.url, { name: sample.name })
      .catch((err) => console.error(err))
      .finally(() => setBusy(null));
  };

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />

      {/* External controls demonstrating the programmatic API */}
      <div
        style={{
          position: 'absolute',
          top: 10,
          left: 10,
          zIndex: 1,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          background: 'rgba(255,255,255,0.92)',
          padding: 10,
          borderRadius: 8,
          boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
          width: 180,
        }}
      >
        <button onClick={toggle} style={buttonStyle}>
          {state.collapsed ? 'Expand' : 'Collapse'} Panel
        </button>
        {SAMPLES.map((sample) => (
          <button
            key={sample.label}
            onClick={() => loadSample(sample)}
            disabled={busy !== null}
            style={buttonStyle}
          >
            {busy === sample.label ? 'Loading...' : `Load ${sample.label}`}
          </button>
        ))}
        <div style={{ fontSize: 12, color: '#475467' }}>
          {state.layers.length} layer{state.layers.length === 1 ? '' : 's'} loaded
        </div>
      </div>

      {/* Vector control */}
      {map && (
        <VectorControlReact
          map={map}
          controlRef={controlRef}
          title="Vector Data"
          collapsed={state.collapsed}
          panelWidth={320}
          onStateChange={(newState) => setState(newState)}
          onLayerAdded={(layer) => console.log('Layer added:', layer)}
          onError={(error) => console.error('Vector control error:', error)}
        />
      )}
    </div>
  );
}

const buttonStyle: CSSProperties = {
  padding: '8px 12px',
  background: '#4a90d9',
  color: 'white',
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
  fontWeight: 500,
  fontSize: 12,
};

// Mount the app
const root = createRoot(document.getElementById('root')!);
root.render(<App />);
