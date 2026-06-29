import maplibregl from 'maplibre-gl';
import { VectorControl } from '../../src/index';
import '../../src/index.css';
import 'maplibre-gl/dist/maplibre-gl.css';

// Sample datasets (CORS-friendly GitHub release assets)
const SAMPLES = {
  geojson: new URL('../data/sample.geojson', import.meta.url).href,
  geoparquet: 'https://raw.githubusercontent.com/opengeos/data/main/duckdb/countries.parquet',
  geopackage: 'https://raw.githubusercontent.com/opengeos/data/main/us/us_regions.gpkg',
  csv: 'https://raw.githubusercontent.com/opengeos/data/main/world/world_cities.csv',
  counties: 'https://raw.githubusercontent.com/opengeos/data/main/us/us_counties.parquet',
};

// Create map
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/positron',
  center: [-98, 39],
  zoom: 3,
});

// Add navigation controls to top-right
map.addControl(new maplibregl.NavigationControl(), 'top-right');

// Add fullscreen control to top-right (after navigation)
map.addControl(new maplibregl.FullscreenControl(), 'top-right');

// Add the vector control when the map loads
map.on('load', () => {
  const vectorControl = new VectorControl({
    title: 'Vector Data',
    collapsed: false,
    panelWidth: 320,
    // Keep the panel open until the close button is clicked (clicking the
    // map should not collapse it).
    closeOnOutsideClick: false,
    // Let the panel be dragged larger from its bottom corners.
    resizable: true,
    // Sample datasets are offered inside the panel (below the URL input).
    // Choosing one fills the URL; the user still clicks Load to ingest it.
    sampleData: [
      { label: 'GeoParquet', url: SAMPLES.geoparquet, name: 'Countries' },
      { label: 'GeoPackage', url: SAMPLES.geopackage, name: 'US regions' },
      { label: 'CSV', url: SAMPLES.csv, name: 'World cities' },
      {
        label: 'Tiles mode',
        url: SAMPLES.counties,
        name: 'US counties (tiles)',
        renderMode: 'tiles',
      },
    ],
  });

  map.addControl(vectorControl, 'top-left');

  // Listen for layer events
  vectorControl.on('layeradded', (event) => {
    console.log('Layer added:', event.layer);
  });

  vectorControl.on('layerremoved', (event) => {
    console.log('Layer removed:', event.layer?.name);
  });

  vectorControl.on('error', (event) => {
    console.error('Vector control error:', event.error);
  });

  // Load the local GeoJSON sample programmatically
  void vectorControl
    .addData(SAMPLES.geojson, { name: 'Tahoe sample' })
    .catch((err) => console.error(err));
});
