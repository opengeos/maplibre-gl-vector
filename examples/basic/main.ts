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
  style: 'https://demotiles.maplibre.org/style.json',
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
  });

  map.addControl(vectorControl, 'top-right');

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

  // Wire the sample buttons
  const buttons: Array<[string, () => Promise<unknown>]> = [
    ['load-geoparquet', () => vectorControl.addData(SAMPLES.geoparquet, { name: 'Countries' })],
    ['load-geopackage', () => vectorControl.addData(SAMPLES.geopackage, { name: 'US regions' })],
    ['load-csv', () => vectorControl.addData(SAMPLES.csv, { name: 'World cities' })],
    [
      'load-tiles',
      () =>
        vectorControl.addData(SAMPLES.counties, {
          name: 'US counties (tiles)',
          renderMode: 'tiles',
        }),
    ],
  ];
  for (const [id, load] of buttons) {
    const button = document.getElementById(id);
    button?.addEventListener('click', () => {
      button.setAttribute('disabled', 'true');
      void load()
        .catch((err) => console.error(err))
        .finally(() => button.removeAttribute('disabled'));
    });
  }
});
