import type { Map, PropertyValueSpecification } from 'maplibre-gl';
import type { GeoJSON } from 'geojson';

/**
 * Rendering mode for a vector layer.
 *
 * - `'auto'` - Decide based on dataset size thresholds
 * - `'geojson'` - Convert to GeoJSON and render with a geojson source
 * - `'tiles'` - Generate dynamic MVT tiles with DuckDB per z/x/y
 */
export type RenderMode = 'auto' | 'geojson' | 'tiles';

/**
 * How a dataset is ingested into DuckDB.
 *
 * - `'table'` - Materialize into an in-memory table with an EPSG:3857
 *   column and R-Tree index (fast tiles; memory ~= dataset size)
 * - `'stream'` - GeoParquet only: query the file in place through a
 *   view. Remote files are read with HTTP range requests per tile,
 *   using the GeoParquet bbox covering column for row-group pruning
 *   when present. Nothing is copied into the database.
 */
export type IngestMode = 'table' | 'stream';

/**
 * Vector data formats recognized by the control.
 *
 * The named values get dedicated readers; any other extension (kml,
 * gml, tab, dxf, ...) is passed through as-is and read with the
 * spatial extension's GDAL-backed ST_Read, so every format the
 * spatial extension supports works. 'unknown' means the format could
 * not be determined at all (no extension); it is still attempted via
 * ST_Read.
 */
export type VectorFormat =
  | 'geojson'
  | 'geopackage'
  | 'shapefile'
  | 'geoparquet'
  | 'flatgeobuf'
  | 'csv'
  | 'unknown'
  | (string & {});

/**
 * Broad geometry category of a layer, used to pick map layer types.
 */
export type GeometryCategory = 'point' | 'line' | 'polygon' | 'mixed' | 'unknown';

/**
 * How point features are rendered (geojson render mode only).
 *
 * - `'circle'` - One circle per point (the default)
 * - `'heatmap'` - A density heatmap surface
 * - `'cluster'` - Nearby points grouped into counted bubbles
 */
export type PointMode = 'circle' | 'heatmap' | 'cluster';

/**
 * Input data accepted by `VectorControl.addData`: a URL, a local
 * File/Blob, or a GeoJSON object.
 */
export type VectorDataSource = string | File | Blob | GeoJSON;

/**
 * Thresholds that trip `'auto'` render mode from GeoJSON to dynamic tiles.
 */
export interface AutoThreshold {
  /**
   * Maximum feature count rendered as GeoJSON
   * @default 50000
   */
  featureCount?: number;

  /**
   * Maximum source size in bytes rendered as GeoJSON
   * @default 26214400 (25 MB)
   */
  byteSize?: number;
}

/**
 * A named sample dataset offered as a one-click "Load sample data" link
 * in the panel, rendered below the URL input. Lets a host advertise
 * ready-to-load examples without prefilling the URL input (which stays
 * empty for the user's own links).
 */
export interface VectorSampleDataset {
  /** Link text shown to the user (e.g. 'Countries') */
  label: string;

  /** Source URL loaded when the link is clicked */
  url: string;

  /** Display name for the loaded layer (defaults to the file name) */
  name?: string;

  /**
   * Ingest mode for this sample. When omitted, the panel's streaming
   * toggle decides, matching a manual URL load.
   */
  ingestMode?: IngestMode;

  /** Render mode for this sample (defaults to the control's setting) */
  renderMode?: RenderMode;
}

/**
 * Options for configuring the VectorControl
 */
export interface VectorControlOptions {
  /**
   * Whether the control panel should start collapsed (showing only the toggle button)
   * @default true
   */
  collapsed?: boolean;

  /**
   * Position of the control on the map
   * @default 'top-right'
   */
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

  /**
   * Title displayed in the control header
   * @default 'Vector Data'
   */
  title?: string;

  /**
   * Width of the control panel in pixels
   * @default 320
   */
  panelWidth?: number;

  /**
   * Custom CSS class name for the control container
   */
  className?: string;

  /**
   * Thresholds used by `'auto'` render mode
   */
  autoThreshold?: AutoThreshold;

  /**
   * Default render mode for layers that do not specify one
   * @default 'auto'
   */
  defaultRenderMode?: RenderMode;

  /**
   * Maximum zoom level for dynamic tile generation
   * @default 16
   */
  maxTileZoom?: number;

  /**
   * Attribution string attached to created sources
   */
  attribution?: string;

  /**
   * Existing map layer id that new vector layers are inserted before
   * (e.g. a label layer), so loaded data renders underneath it.
   * Per-layer `beforeId` overrides this.
   */
  beforeId?: string;

  /**
   * Whether clicking a feature opens a popup with its attributes.
   * Per-layer `picker` overrides this.
   * @default true
   */
  enablePicker?: boolean;

  /**
   * Default ingest mode for new layers (per-layer `ingestMode` wins)
   * @default 'table'
   */
  defaultIngestMode?: IngestMode;

  /**
   * Placeholder text shown in the panel's URL input
   * @default 'https://example.com/data.parquet'
   */
  urlPlaceholder?: string;

  /**
   * Initial value of the panel's URL input, so a host can offer a
   * ready-to-load sample dataset (the input clears after a successful
   * load)
   */
  defaultUrl?: string;

  /**
   * Automatically load `defaultUrl` when the control is added to the
   * map, as if the user had pressed Load (no-op without `defaultUrl`)
   * @default false
   */
  autoLoad?: boolean;

  /**
   * Collapse the panel when the user clicks outside it (e.g. on the map).
   * Set to `false` to keep the panel open until the user closes it with
   * the header's close button.
   * @default true
   */
  closeOnOutsideClick?: boolean;

  /**
   * Show drag handles in the panel's bottom-left and bottom-right
   * corners so the user can resize it. The bottom-right handle grows the
   * panel rightward, the bottom-left handle leftward (keeping the
   * opposite edge fixed); both grow it downward. The chosen size is kept
   * for the session.
   * @default false
   */
  resizable?: boolean;

  /**
   * Optional sample datasets offered as one-click "Load sample data"
   * links below the URL input. Clicking a link loads that dataset
   * directly. Omit or leave empty to hide the row entirely, keeping the
   * URL input clean for the user's own links.
   */
  sampleData?: VectorSampleDataset[];

  /**
   * Placeholder shown in the sample-data dropdown before a selection
   * (e.g. 'Load sample data...'). Ignored when {@link sampleData} is
   * empty.
   * @default 'Load sample data...'
   */
  sampleDataLabel?: string;

  /**
   * Base URL to load DuckDB-WASM from instead of the default jsDelivr CDN.
   *
   * Use this to self-host (or mirror) the assets and avoid the CDN request
   * (and the `script-src https://cdn.jsdelivr.net` CSP allowance it needs).
   * The base must mirror jsDelivr's layout for the pinned duckdb-wasm
   * version: an `/+esm` ES-module bundle plus the `/dist/*` wasm and worker
   * files. For example, `'/vendor/duckdb-wasm-1.31.0'` served from the host's
   * own origin. Defaults to jsDelivr when unset.
   */
  duckdbWasmBaseUrl?: string;

  /**
   * Base URL to load sql.js from instead of the default jsDelivr CDN.
   *
   * sql.js is loaded on demand only when a GeoPackage is added, to repair
   * files missing the `gpkg_ogr_contents` feature-count table (without it,
   * GDAL crashes single-threaded DuckDB-WASM with a thread-constructor error).
   * The base must mirror jsDelivr's layout for the pinned sql.js version: a
   * `/dist/sql-wasm.js` UMD script plus the matching `/dist/sql-wasm.wasm`.
   * Set this alongside {@link duckdbWasmBaseUrl} to fully self-host and avoid
   * the `script-src https://cdn.jsdelivr.net` CSP allowance. Defaults to
   * jsDelivr when unset.
   */
  sqlJsBaseUrl?: string;

  /**
   * Path or URL to a prebuilt DuckDB spatial extension.
   *
   * When set, the engine loads the extension with `LOAD '<path>'` and skips
   * the remote `INSTALL spatial` step. Use this in sandboxed or firewalled
   * environments where DuckDB's extension repository is unreachable: without
   * it, loading a non-GeoJSON source (or any source routed through the engine)
   * hangs indefinitely on the blocked `INSTALL spatial`. The path must point at
   * an extension built for the pinned duckdb-wasm version's DuckDB core.
   * Defaults to a remote `INSTALL spatial; LOAD spatial;` when unset.
   */
  spatialExtensionPath?: string;
}

/**
 * Per-layer style properties applied to the generated map layers.
 */
export interface VectorLayerStyle {
  /** Polygon fill color */
  fillColor: string;
  /** Polygon fill opacity (0-1) */
  fillOpacity: number;
  /** Line and polygon outline color */
  lineColor: string;
  /** Line and polygon outline width in pixels */
  lineWidth: number;
  /** Point circle color */
  circleColor: string;
  /** Point circle radius in pixels */
  circleRadius: number;
  /** Point circle opacity (0-1) */
  circleOpacity: number;
  /**
   * Optional data-driven override for the polygon fill color, e.g. a
   * categorized `['match', ...]` or graduated `['interpolate', ...]`
   * expression. When set it takes precedence over `fillColor` (which remains
   * the flat fallback). Lets a host application apply attribute-driven
   * styling that a single color cannot express.
   */
  fillColorExpression?: PropertyValueSpecification<string>;
  /** Optional data-driven override for the line and polygon outline color. */
  lineColorExpression?: PropertyValueSpecification<string>;
  /** Optional data-driven override for the point circle color. */
  circleColorExpression?: PropertyValueSpecification<string>;
  /**
   * How point features are rendered. Only applies to point layers in the
   * `'geojson'` render mode (tiles always use circles).
   * @default 'circle'
   */
  pointMode?: PointMode;
  /**
   * Heatmap kernel radius in pixels (when `pointMode` is `'heatmap'`).
   * @default 30
   */
  heatmapRadius?: number;
  /**
   * Heatmap intensity multiplier (when `pointMode` is `'heatmap'`).
   * @default 1
   */
  heatmapIntensity?: number;
  /**
   * Cluster radius in pixels (when `pointMode` is `'cluster'`).
   * @default 50
   */
  clusterRadius?: number;
  /**
   * Maximum zoom at which points still cluster (when `pointMode` is
   * `'cluster'`).
   * @default 14
   */
  clusterMaxZoom?: number;
}

/**
 * Options for adding a vector layer via `VectorControl.addData`.
 */
export interface VectorLayerOptions {
  /**
   * Unique layer id (auto-generated when omitted)
   */
  id?: string;

  /**
   * Display name shown in the layer list (defaults to the file name)
   */
  name?: string;

  /**
   * Render mode override for this layer
   * @default 'auto'
   */
  renderMode?: RenderMode;

  /**
   * Whether the layer starts visible
   * @default true
   */
  visible?: boolean;

  /**
   * Master opacity (0-1) multiplied into every style opacity
   * @default 1
   */
  opacity?: number;

  /**
   * Whether to zoom the map to the layer extent after adding
   * @default true
   */
  fitBounds?: boolean;

  /**
   * Initial style overrides
   */
  style?: Partial<VectorLayerStyle>;

  /**
   * Named layer inside multi-layer containers (e.g. a GeoPackage table)
   */
  sourceLayer?: string;

  /**
   * Explicit format when it cannot be detected from the file name/URL
   */
  format?: VectorFormat;

  /**
   * Existing map layer id this layer's map layers are inserted before
   * (overrides the control-level `beforeId`)
   */
  beforeId?: string;

  /**
   * Whether clicking a feature of this layer opens an attribute popup
   * (overrides the control-level `enablePicker`)
   */
  picker?: boolean;

  /**
   * How the dataset is ingested (GeoParquet supports 'stream')
   * @default 'table'
   */
  ingestMode?: IngestMode;
}

/**
 * Where a layer's data came from. URL-backed layers can be recreated
 * from this descriptor (e.g. when a host application restores a saved
 * project); file- and object-backed layers cannot. A discriminated
 * union, so a URL-backed descriptor always carries the URL needed to
 * recreate the layer.
 */
export type VectorSourceDescriptor =
  | {
      /** The data was loaded from a URL */
      kind: 'url';
      /** The source URL */
      url: string;
    }
  | {
      /** The data came from a local File/Blob */
      kind: 'file';
      /** The local file name (when known) */
      fileName?: string;
    }
  | {
      /** The data was passed as a GeoJSON object */
      kind: 'geojson';
    };

/**
 * Metadata describing a loaded vector layer.
 */
export interface VectorLayerInfo {
  /** Unique layer id */
  id: string;
  /** Display name */
  name: string;
  /** Where the data came from */
  source: VectorSourceDescriptor;
  /** Detected source format */
  format: VectorFormat;
  /** Resolved render mode (never 'auto') */
  renderMode: 'geojson' | 'tiles';
  /** Broad geometry category */
  geometryType: GeometryCategory;
  /** Number of features, when known */
  featureCount?: number;
  /** Source size in bytes, when known */
  byteSize?: number;
  /** Layer extent in EPSG:4326 [minX, minY, maxX, maxY] */
  bbox?: [number, number, number, number];
  /** Whether the layer is currently visible */
  visible: boolean;
  /** Master opacity (0-1) multiplied into every style opacity */
  opacity: number;
  /** Whether clicking a feature opens an attribute popup */
  picker: boolean;
  /** How the dataset was ingested ('stream' = queried in place) */
  ingestMode: IngestMode;
  /** Named layer inside a multi-layer container, when one was selected */
  sourceLayer?: string;
  /** Map layer id this layer's map layers sit before, when set */
  beforeId?: string;
  /** Current style */
  style: VectorLayerStyle;
  /** Map source id */
  sourceId: string;
  /** Map layer ids created for this layer */
  layerIds: string[];
}

/**
 * Internal state of the vector control
 */
export interface VectorState {
  /**
   * Whether the control panel is currently collapsed
   */
  collapsed: boolean;

  /**
   * Current panel width in pixels
   */
  panelWidth: number;

  /**
   * Loaded vector layers
   */
  layers: VectorLayerInfo[];

  /**
   * Any custom state data
   */
  data?: Record<string, unknown>;
}

/**
 * Props for the React wrapper component
 */
export interface VectorControlReactProps extends VectorControlOptions {
  /**
   * MapLibre GL map instance
   */
  map: Map;

  /**
   * Callback fired when the control state changes
   */
  onStateChange?: (state: VectorState) => void;

  /**
   * Callback fired when a layer finishes loading
   */
  onLayerAdded?: (layer: VectorLayerInfo) => void;

  /**
   * Callback fired when a layer is removed
   */
  onLayerRemoved?: (layer: VectorLayerInfo) => void;

  /**
   * Callback fired when loading data fails
   */
  onError?: (error: Error) => void;
}

/**
 * Event types emitted by the vector control
 */
export type VectorControlEvent =
  | 'collapse'
  | 'expand'
  | 'statechange'
  | 'layeradded'
  | 'layerremoved'
  | 'layerupdated'
  | 'loading'
  | 'error';

/**
 * Payload passed to event handlers.
 */
export interface VectorEventPayload {
  type: VectorControlEvent;
  state: VectorState;
  /** The layer involved, for layer events */
  layer?: VectorLayerInfo;
  /** The error, for 'error' events */
  error?: Error;
  /** Human-readable progress message, for 'loading' events */
  message?: string;
}

/**
 * Event handler function type
 */
export type VectorControlEventHandler = (event: VectorEventPayload) => void;
