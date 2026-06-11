import type { IControl, Map as MapLibreMap } from 'maplibre-gl';
import type {
  RenderMode,
  VectorControlEvent,
  VectorControlEventHandler,
  VectorControlOptions,
  VectorDataSource,
  VectorEventPayload,
  VectorLayerInfo,
  VectorLayerOptions,
  VectorLayerStyle,
  VectorState,
} from './types';
import { LayerManager } from './LayerManager';
import type { IEngine } from '../engine/types';
import { createEngine } from '../engine/DuckDBEngine';
import { renderPanelUI } from '../ui/panel';

/**
 * Default options for the VectorControl
 */
const DEFAULT_OPTIONS: Required<
  Pick<VectorControlOptions, 'collapsed' | 'position' | 'title' | 'panelWidth' | 'className'>
> = {
  collapsed: true,
  position: 'top-right',
  title: 'Vector Data',
  panelWidth: 320,
  className: '',
};

/**
 * Event handlers map type
 */
type EventHandlersMap = globalThis.Map<VectorControlEvent, Set<VectorControlEventHandler>>;

/**
 * A MapLibre GL control for visualizing vector data in many formats
 * (GeoJSON, GeoPackage, Shapefile, GeoParquet, FlatGeobuf, CSV/WKT).
 *
 * Small datasets are converted to GeoJSON; large datasets are rendered
 * as dynamic MVT tiles generated client-side by DuckDB-WASM and served
 * through a `duckdb://` protocol handler. DuckDB is lazy-loaded from a
 * CDN only when a non-GeoJSON format (or tile rendering) is requested.
 *
 * @example
 * ```typescript
 * const control = new VectorControl({ collapsed: false });
 * map.addControl(control, 'top-right');
 * await control.addData('https://example.com/data.geojson');
 * await control.addData('https://example.com/buildings.parquet');
 * ```
 */
export class VectorControl implements IControl {
  private _map?: MapLibreMap;
  private _mapContainer?: HTMLElement;
  private _container?: HTMLElement;
  private _panel?: HTMLElement;
  private _content?: HTMLElement;
  private _options: VectorControlOptions & typeof DEFAULT_OPTIONS;
  private _state: VectorState;
  private _eventHandlers: EventHandlersMap = new globalThis.Map();
  private _layerManager?: LayerManager;
  private _enginePromise?: Promise<IEngine>;
  private _disposePanelUI?: () => void;

  // Panel positioning handlers
  private _resizeHandler: (() => void) | null = null;
  private _mapResizeHandler: (() => void) | null = null;
  private _clickOutsideHandler: ((e: MouseEvent) => void) | null = null;

  /**
   * Creates a new VectorControl instance.
   *
   * @param options - Configuration options for the control
   */
  constructor(options?: Partial<VectorControlOptions>) {
    this._options = { ...DEFAULT_OPTIONS, ...options };
    this._state = {
      collapsed: this._options.collapsed,
      panelWidth: this._options.panelWidth,
      layers: [],
      data: {},
    };
  }

  /**
   * Called when the control is added to the map.
   * Implements the IControl interface.
   *
   * @param map - The MapLibre GL map instance
   * @returns The control's container element
   */
  onAdd(map: MapLibreMap): HTMLElement {
    this._map = map;
    this._mapContainer = map.getContainer();
    this._container = this._createContainer();
    this._panel = this._createPanel();

    this._layerManager = new LayerManager({
      map,
      options: this._options,
      emit: (type, extra) => this._emit(type, extra),
      getEngine: () => this._getEngine(),
    });

    // Append panel to map container for independent positioning (avoids overlap with other controls)
    this._mapContainer.appendChild(this._panel);

    // Render the data loading / layer list UI into the panel content area
    if (this._content) {
      this._disposePanelUI = renderPanelUI({
        container: this._content,
        control: this,
        urlPlaceholder: this._options.urlPlaceholder,
        defaultUrl: this._options.defaultUrl,
        autoLoad: this._options.autoLoad,
      });
    }

    // Setup event listeners for panel positioning and click-outside
    this._setupEventListeners();

    // Set initial panel state
    if (!this._state.collapsed) {
      this._panel.classList.add('expanded');
      // Update position after control is added to DOM
      requestAnimationFrame(() => {
        this._updatePanelPosition();
      });
    }

    return this._container;
  }

  /**
   * Called when the control is removed from the map.
   * Implements the IControl interface.
   */
  onRemove(): void {
    // Remove event listeners
    if (this._resizeHandler) {
      window.removeEventListener('resize', this._resizeHandler);
      this._resizeHandler = null;
    }
    if (this._mapResizeHandler && this._map) {
      this._map.off('resize', this._mapResizeHandler);
      this._mapResizeHandler = null;
    }
    if (this._clickOutsideHandler) {
      document.removeEventListener('click', this._clickOutsideHandler);
      this._clickOutsideHandler = null;
    }

    // Tear down panel UI and layers
    this._disposePanelUI?.();
    this._disposePanelUI = undefined;
    this._layerManager?.dispose();
    this._layerManager = undefined;

    // Terminate the DuckDB worker if it was loaded
    if (this._enginePromise) {
      this._enginePromise.then((engine) => engine.dispose()).catch(() => undefined);
      this._enginePromise = undefined;
    }

    // Remove panel from map container
    this._panel?.parentNode?.removeChild(this._panel);

    // Remove button container from control stack
    this._container?.parentNode?.removeChild(this._container);

    this._map = undefined;
    this._mapContainer = undefined;
    this._container = undefined;
    this._panel = undefined;
    this._content = undefined;
    this._eventHandlers.clear();
  }

  // ---------------------------------------------------------------------
  // Data API
  // ---------------------------------------------------------------------

  /**
   * Loads a vector data source and adds it to the map.
   *
   * @param source - URL string, File/Blob, or GeoJSON object
   * @param options - Layer options
   * @returns Metadata of the added layer
   */
  async addData(
    source: VectorDataSource,
    options?: VectorLayerOptions,
  ): Promise<VectorLayerInfo> {
    return this._manager().addData(source, options);
  }

  /**
   * Removes a layer added with {@link addData}.
   *
   * @param id - The layer id
   */
  removeLayer(id: string): void {
    this._layerManager?.removeLayer(id);
  }

  /**
   * Removes all layers added with {@link addData}.
   */
  removeAll(): void {
    this._layerManager?.removeAll();
  }

  /**
   * Returns metadata for all loaded layers.
   */
  getLayers(): VectorLayerInfo[] {
    return this._layerManager?.getLayers() ?? [];
  }

  /**
   * Returns metadata for a single layer.
   *
   * @param id - The layer id
   */
  getLayer(id: string): VectorLayerInfo | undefined {
    return this._layerManager?.getLayer(id);
  }

  /**
   * Shows or hides a layer.
   *
   * @param id - The layer id
   * @param visible - Whether the layer should be visible
   */
  setLayerVisibility(id: string, visible: boolean): void {
    this._layerManager?.setLayerVisibility(id, visible);
  }

  /**
   * Zooms the map to a layer's extent.
   *
   * @param id - The layer id
   */
  zoomToLayer(id: string): void {
    this._layerManager?.zoomToLayer(id);
  }

  /**
   * Applies a style patch to a layer.
   *
   * @param id - The layer id
   * @param style - Partial style update
   */
  setLayerStyle(id: string, style: Partial<VectorLayerStyle>): void {
    this._layerManager?.setLayerStyle(id, style);
  }

  /**
   * Sets a layer's master opacity, multiplied into every style opacity
   * (fill, circle, and line layers alike).
   *
   * @param id - The layer id
   * @param opacity - The new opacity (0-1)
   */
  setLayerOpacity(id: string, opacity: number): void {
    this._layerManager?.setLayerOpacity(id, opacity);
  }

  /**
   * Enables or disables the attribute popup for a layer.
   *
   * @param id - The layer id
   * @param enabled - Whether clicking a feature opens a popup
   */
  setLayerPicker(id: string, enabled: boolean): void {
    this._layerManager?.setLayerPicker(id, enabled);
  }

  /**
   * Moves a layer's map layers before another map layer (or to the top
   * when omitted).
   *
   * @param id - The layer id
   * @param beforeId - Target map layer id, or undefined for the top
   */
  setLayerBeforeId(id: string, beforeId?: string): void {
    this._layerManager?.setLayerBeforeId(id, beforeId);
  }

  /**
   * Switches a layer between GeoJSON and dynamic tile rendering.
   *
   * @param id - The layer id
   * @param mode - The requested render mode
   */
  async setRenderMode(id: string, mode: RenderMode): Promise<void> {
    return this._manager().setRenderMode(id, mode);
  }

  /**
   * Re-fetches a URL-backed layer's data and re-renders it in place,
   * keeping the same layer id, source, style, render mode, and position.
   * In-memory GeoJSON and File sources are static, so reloading them is a
   * no-op that returns the current layer info.
   *
   * @param id - The layer id
   * @returns The refreshed layer info, or undefined when no such layer exists
   */
  async reloadLayer(id: string): Promise<VectorLayerInfo | undefined> {
    return this._layerManager?.reloadLayer(id);
  }

  // ---------------------------------------------------------------------
  // State and events
  // ---------------------------------------------------------------------

  /**
   * Gets the current state of the control.
   *
   * @returns The current control state
   */
  getState(): VectorState {
    return {
      ...this._state,
      layers: this._layerManager?.getLayers() ?? this._state.layers,
    };
  }

  /**
   * Updates the control state.
   *
   * @param newState - Partial state to merge with current state
   */
  setState(newState: Partial<VectorState>): void {
    this._state = { ...this._state, ...newState };
    this._emit('statechange');
  }

  /**
   * Toggles the collapsed state of the control panel.
   */
  toggle(): void {
    this._state.collapsed = !this._state.collapsed;

    if (this._panel) {
      if (this._state.collapsed) {
        this._panel.classList.remove('expanded');
        this._emit('collapse');
      } else {
        this._panel.classList.add('expanded');
        this._updatePanelPosition();
        this._emit('expand');
      }
    }

    this._emit('statechange');
  }

  /**
   * Expands the control panel.
   */
  expand(): void {
    if (this._state.collapsed) {
      this.toggle();
    }
  }

  /**
   * Collapses the control panel.
   */
  collapse(): void {
    if (!this._state.collapsed) {
      this.toggle();
    }
  }

  /**
   * Registers an event handler.
   *
   * @param event - The event type to listen for
   * @param handler - The callback function
   */
  on(event: VectorControlEvent, handler: VectorControlEventHandler): void {
    if (!this._eventHandlers.has(event)) {
      this._eventHandlers.set(event, new Set());
    }
    this._eventHandlers.get(event)!.add(handler);
  }

  /**
   * Removes an event handler.
   *
   * @param event - The event type
   * @param handler - The callback function to remove
   */
  off(event: VectorControlEvent, handler: VectorControlEventHandler): void {
    this._eventHandlers.get(event)?.delete(handler);
  }

  /**
   * Gets the map instance.
   *
   * @returns The MapLibre GL map instance or undefined if not added to a map
   */
  getMap(): MapLibreMap | undefined {
    return this._map;
  }

  /**
   * Gets the control container element.
   *
   * @returns The container element or undefined if not added to a map
   */
  getContainer(): HTMLElement | undefined {
    return this._container;
  }

  /**
   * Gets the panel content element that hosts the control UI.
   *
   * @returns The content element or undefined if not added to a map
   */
  getContentElement(): HTMLElement | undefined {
    return this._content;
  }

  /**
   * Returns the layer manager, throwing when the control has not been
   * added to a map yet.
   */
  private _manager(): LayerManager {
    if (!this._layerManager) {
      throw new Error('VectorControl must be added to a map before loading data');
    }
    return this._layerManager;
  }

  /**
   * Lazily creates the shared DuckDB engine on first use.
   */
  private _getEngine(): Promise<IEngine> {
    if (!this._enginePromise) {
      this._enginePromise = createEngine({
        onProgress: (message) => this._emit('loading', { message }),
        baseUrl: this._options.duckdbWasmBaseUrl,
      });
      // Allow a retry on the next request when engine creation fails
      // (e.g. the CDN was unreachable).
      this._enginePromise.catch(() => {
        this._enginePromise = undefined;
      });
    }
    return this._enginePromise;
  }

  /**
   * Emits an event to all registered handlers.
   *
   * @param event - The event type to emit
   * @param extra - Optional layer/error/message context
   */
  private _emit(
    event: VectorControlEvent,
    extra?: Pick<VectorEventPayload, 'layer' | 'error' | 'message'>,
  ): void {
    const handlers = this._eventHandlers.get(event);
    if (handlers) {
      const eventData: VectorEventPayload = { type: event, state: this.getState(), ...extra };
      handlers.forEach((handler) => handler(eventData));
    }
    // Layer events also imply a state change for state subscribers.
    if (event === 'layeradded' || event === 'layerremoved' || event === 'layerupdated') {
      this._emit('statechange');
    }
  }

  /**
   * Creates the main container element for the control.
   * Contains a toggle button (29x29) matching navigation control size.
   *
   * @returns The container element
   */
  private _createContainer(): HTMLElement {
    const container = document.createElement('div');
    container.className = `maplibregl-ctrl maplibregl-ctrl-group vector-control${
      this._options.className ? ` ${this._options.className}` : ''
    }`;

    // Create toggle button (29x29 to match navigation control)
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'vector-control-toggle';
    toggleBtn.type = 'button';
    toggleBtn.setAttribute('aria-label', this._options.title);
    // Vector geometry icon: a triangle of edges with vertex nodes
    // (points, lines, and a polygon in one glyph)
    toggleBtn.innerHTML = `
      <span class="vector-control-icon">
        <svg viewBox="0 0 24 24" width="22" height="22" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="5.5" cy="5.5" r="2.2"/>
          <circle cx="18.5" cy="8.5" r="2.2"/>
          <circle cx="11" cy="19" r="2.2"/>
          <path d="M7.7 6 16.3 8"/>
          <path d="M17.4 10.4 12 17.2"/>
          <path d="M10.3 16.9 6 7.6"/>
        </svg>
      </span>
    `;
    toggleBtn.addEventListener('click', () => this.toggle());

    container.appendChild(toggleBtn);

    return container;
  }

  /**
   * Creates the panel element with header and content areas.
   * Panel is positioned as a dropdown below the toggle button.
   *
   * @returns The panel element
   */
  private _createPanel(): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'vector-control-panel';
    panel.style.width = `${this._options.panelWidth}px`;

    // Create header with title and close button
    const header = document.createElement('div');
    header.className = 'vector-control-header';

    const title = document.createElement('span');
    title.className = 'vector-control-title';
    title.textContent = this._options.title;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'vector-control-close';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close panel');
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', () => this.collapse());

    header.appendChild(title);
    header.appendChild(closeBtn);

    // Create content area (filled by the panel UI)
    const content = document.createElement('div');
    content.className = 'vector-control-content';
    this._content = content;

    panel.appendChild(header);
    panel.appendChild(content);

    return panel;
  }

  /**
   * Setup event listeners for panel positioning and click-outside behavior.
   */
  private _setupEventListeners(): void {
    // Click outside to close (check both container and panel since they're now separate)
    this._clickOutsideHandler = (e: MouseEvent) => {
      const target = e.target as Node;
      // A click on panel UI can re-render the list before the event
      // bubbles here, detaching its target; don't treat that as outside.
      if (!target.isConnected) return;
      if (
        this._container &&
        this._panel &&
        !this._container.contains(target) &&
        !this._panel.contains(target)
      ) {
        this.collapse();
      }
    };
    document.addEventListener('click', this._clickOutsideHandler);

    // Update panel position on window resize
    this._resizeHandler = () => {
      if (!this._state.collapsed) {
        this._updatePanelPosition();
      }
    };
    window.addEventListener('resize', this._resizeHandler);

    // Update panel position on map resize (e.g., sidebar toggle)
    this._mapResizeHandler = () => {
      if (!this._state.collapsed) {
        this._updatePanelPosition();
      }
    };
    this._map?.on('resize', this._mapResizeHandler);
  }

  /**
   * Detect which corner the control is positioned in.
   *
   * @returns The position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
   */
  private _getControlPosition(): 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' {
    const parent = this._container?.parentElement;
    if (!parent) return 'top-right'; // Default

    if (parent.classList.contains('maplibregl-ctrl-top-left')) return 'top-left';
    if (parent.classList.contains('maplibregl-ctrl-top-right')) return 'top-right';
    if (parent.classList.contains('maplibregl-ctrl-bottom-left')) return 'bottom-left';
    if (parent.classList.contains('maplibregl-ctrl-bottom-right')) return 'bottom-right';

    return 'top-right'; // Default
  }

  /**
   * Update the panel position based on button location and control corner.
   * Positions the panel next to the button, expanding in the appropriate direction.
   */
  private _updatePanelPosition(): void {
    if (!this._container || !this._panel || !this._mapContainer) return;

    // Get the toggle button (first child of container)
    const button = this._container.querySelector('.vector-control-toggle');
    if (!button) return;

    const buttonRect = button.getBoundingClientRect();
    const mapRect = this._mapContainer.getBoundingClientRect();
    const position = this._getControlPosition();

    // Calculate button position relative to map container
    const buttonTop = buttonRect.top - mapRect.top;
    const buttonBottom = mapRect.bottom - buttonRect.bottom;
    const buttonLeft = buttonRect.left - mapRect.left;
    const buttonRight = mapRect.right - buttonRect.right;

    const panelGap = 5; // Gap between button and panel

    // Reset all positioning
    this._panel.style.top = '';
    this._panel.style.bottom = '';
    this._panel.style.left = '';
    this._panel.style.right = '';

    switch (position) {
      case 'top-left':
        // Panel expands down and to the right
        this._panel.style.top = `${buttonTop + buttonRect.height + panelGap}px`;
        this._panel.style.left = `${buttonLeft}px`;
        break;

      case 'top-right':
        // Panel expands down and to the left
        this._panel.style.top = `${buttonTop + buttonRect.height + panelGap}px`;
        this._panel.style.right = `${buttonRight}px`;
        break;

      case 'bottom-left':
        // Panel expands up and to the right
        this._panel.style.bottom = `${buttonBottom + buttonRect.height + panelGap}px`;
        this._panel.style.left = `${buttonLeft}px`;
        break;

      case 'bottom-right':
        // Panel expands up and to the left
        this._panel.style.bottom = `${buttonBottom + buttonRect.height + panelGap}px`;
        this._panel.style.right = `${buttonRight}px`;
        break;
    }

    // Constrain the panel to the map so it scrolls instead of
    // overflowing on small screens.
    const edgeMargin = 10;
    const occupied =
      (position.startsWith('top') ? buttonTop : buttonBottom) + buttonRect.height + panelGap;
    const available = mapRect.height - occupied - edgeMargin;
    this._panel.style.maxHeight = `${Math.max(120, available)}px`;
    const availableWidth = Math.max(120, mapRect.width - 2 * edgeMargin);
    this._panel.style.maxWidth = `${availableWidth}px`;
    // Clamp the stylesheet's min-width too, or it overrides maxWidth
    // on very narrow maps.
    this._panel.style.minWidth = `${Math.min(240, availableWidth)}px`;
  }
}
