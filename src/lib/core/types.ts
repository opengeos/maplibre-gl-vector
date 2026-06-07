import type { Map } from 'maplibre-gl';
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
