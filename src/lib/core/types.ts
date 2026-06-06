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
 * Vector data formats supported by the control.
 */
export type VectorFormat =
  | 'geojson'
  | 'geopackage'
  | 'shapefile'
  | 'geoparquet'
  | 'flatgeobuf'
  | 'csv'
  | 'unknown';

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
}

/**
 * Metadata describing a loaded vector layer.
 */
export interface VectorLayerInfo {
  /** Unique layer id */
  id: string;
  /** Display name */
  name: string;
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
