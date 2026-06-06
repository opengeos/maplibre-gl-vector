import type { Map } from 'maplibre-gl';

/**
 * Options for configuring the PluginControl
 */
export interface PluginControlOptions {
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
   * @default 'Plugin Control'
   */
  title?: string;

  /**
   * Width of the control panel in pixels
   * @default 300
   */
  panelWidth?: number;

  /**
   * Custom CSS class name for the control container
   */
  className?: string;
}

/**
 * Internal state of the plugin control
 */
export interface PluginState {
  /**
   * Whether the control panel is currently collapsed
   */
  collapsed: boolean;

  /**
   * Current panel width in pixels
   */
  panelWidth: number;

  /**
   * Any custom state data
   */
  data?: Record<string, unknown>;
}

/**
 * Props for the React wrapper component
 */
export interface PluginControlReactProps extends PluginControlOptions {
  /**
   * MapLibre GL map instance
   */
  map: Map;

  /**
   * Callback fired when the control state changes
   */
  onStateChange?: (state: PluginState) => void;
}

/**
 * Event types emitted by the plugin control
 */
export type PluginControlEvent = 'collapse' | 'expand' | 'statechange';

/**
 * Event handler function type
 */
export type PluginControlEventHandler = (event: { type: PluginControlEvent; state: PluginState }) => void;
