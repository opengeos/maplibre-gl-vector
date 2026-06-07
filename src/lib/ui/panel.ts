import type { Map as MapLibreMap } from 'maplibre-gl';
import type {
  RenderMode,
  VectorControlEvent,
  VectorControlEventHandler,
  VectorDataSource,
  VectorLayerInfo,
  VectorLayerOptions,
  VectorLayerStyle,
} from '../core/types';
import { el, svgIcon, ICONS } from './dom';
import { createLayerListItem } from './layerListItem';

/**
 * The control surface the panel UI talks to. `VectorControl` satisfies
 * this structurally; the interface avoids a circular import.
 */
export interface PanelHost {
  addData(source: VectorDataSource, options?: VectorLayerOptions): Promise<VectorLayerInfo>;
  removeLayer(id: string): void;
  getLayers(): VectorLayerInfo[];
  setLayerVisibility(id: string, visible: boolean): void;
  zoomToLayer(id: string): void;
  setLayerStyle(id: string, style: Partial<VectorLayerStyle>): void;
  setLayerPicker(id: string, enabled: boolean): void;
  setLayerBeforeId(id: string, beforeId?: string): void;
  setRenderMode(id: string, mode: RenderMode): Promise<void>;
  getMap(): MapLibreMap | undefined;
  on(event: VectorControlEvent, handler: VectorControlEventHandler): void;
  off(event: VectorControlEvent, handler: VectorControlEventHandler): void;
}

/**
 * Options for rendering the panel UI.
 */
export interface PanelUIOptions {
  /** The panel content element to render into */
  container: HTMLElement;
  /** The owning control */
  control: PanelHost;
}

/**
 * Renders the vector control panel UI (file/URL loading, status line,
 * and the layer list) and wires it to the control.
 *
 * @param options - Panel options
 * @returns A dispose function that unsubscribes event handlers
 */
export function renderPanelUI(options: PanelUIOptions): () => void {
  const { container, control } = options;
  const expandedEditors = new Set<string>();
  let styleEditInProgress = false;

  container.innerHTML = '';

  // --- Drop zone / file picker -----------------------------------------
  const dropZone = el('div', 'vector-control-dropzone');
  dropZone.appendChild(svgIcon(ICONS.upload, 18));
  const dropText = el('span');
  dropText.textContent = 'Drop file or click to browse';
  dropZone.appendChild(dropText);

  // No accept filter: every format the spatial extension's GDAL build
  // can read (kml, gml, tab, dxf, ...) is fair game, not just the
  // extensions with dedicated readers.
  const fileInput = el('input') as HTMLInputElement;
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.style.display = 'none';

  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const files = e.dataTransfer?.files;
    if (files) loadFiles(files);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files) loadFiles(fileInput.files);
    fileInput.value = '';
  });

  // --- URL input ---------------------------------------------------------
  const urlRow = el('div', 'vector-control-flex vector-control-url-row');
  const urlInput = el('input', 'vector-control-input') as HTMLInputElement;
  urlInput.type = 'url';
  urlInput.placeholder = 'https://example.com/data.geojson';
  const urlButton = el('button', 'vector-control-button', { type: 'button' });
  urlButton.textContent = 'Load';
  const loadUrl = () => {
    const url = urlInput.value.trim();
    if (!url) return;
    void control.addData(url, loadOptions()).then(
      () => {
        urlInput.value = '';
      },
      () => {
        // Error already surfaced through the 'error' event.
      },
    );
  };
  urlButton.addEventListener('click', loadUrl);
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadUrl();
  });
  urlRow.appendChild(urlInput);
  urlRow.appendChild(urlButton);

  // --- Streaming toggle ----------------------------------------------------
  // Applies to subsequent loads; GeoParquet only (others fall back to
  // a materialized table).
  const streamRow = el('label', 'vector-control-stream-row', {
    title:
      'Query GeoParquet in place with HTTP range requests instead of copying it into DuckDB. ' +
      'Best for large remote files with a bbox covering column.',
  });
  const streamInput = el('input', 'vector-control-checkbox') as HTMLInputElement;
  streamInput.type = 'checkbox';
  const streamText = el('span');
  streamText.textContent = 'Stream GeoParquet (no copy)';
  streamRow.appendChild(streamInput);
  streamRow.appendChild(streamText);

  // --- Status line ---------------------------------------------------------
  const status = el('div', 'vector-control-status');
  status.style.display = 'none';

  function setStatus(message: string | null, isError = false): void {
    if (!message) {
      status.style.display = 'none';
      status.textContent = '';
      return;
    }
    status.style.display = 'block';
    status.textContent = message;
    status.classList.toggle('error', isError);
  }

  // --- Layer list ------------------------------------------------------------
  const listTitle = el('div', 'vector-control-section-title');
  listTitle.textContent = 'Layers';
  const list = el('div', 'vector-control-layer-list');
  const empty = el('div', 'vector-control-empty');
  empty.textContent = 'No layers loaded yet';

  function renderList(): void {
    const layers = control.getLayers();
    list.innerHTML = '';
    if (layers.length === 0) {
      list.appendChild(empty);
      return;
    }
    // Map layers this control did not create, as insert-before targets
    const ownLayerIds = new Set(layers.flatMap((layer) => layer.layerIds));
    const beforeChoices = (control.getMap()?.getStyle()?.layers ?? [])
      .map((mapLayer) => mapLayer.id)
      .filter((mapLayerId) => !ownLayerIds.has(mapLayerId));
    for (const layer of layers) {
      list.appendChild(
        createLayerListItem(layer, expandedEditors.has(layer.id), { beforeChoices }, {
          onToggleVisibility: (id, visible) => control.setLayerVisibility(id, visible),
          onZoom: (id) => control.zoomToLayer(id),
          onRemove: (id) => {
            expandedEditors.delete(id);
            control.removeLayer(id);
          },
          onStyle: (id, patch) => {
            // Avoid re-rendering the list mid color-drag (focus loss).
            styleEditInProgress = true;
            try {
              control.setLayerStyle(id, patch);
            } finally {
              styleEditInProgress = false;
            }
          },
          onRenderMode: (id, mode) => {
            void control.setRenderMode(id, mode).catch(() => {
              // Error already surfaced through the 'error' event.
            });
          },
          onPicker: (id, enabled) => control.setLayerPicker(id, enabled),
          onBeforeId: (id, beforeId) => control.setLayerBeforeId(id, beforeId),
          onToggleEditor: (id) => {
            if (expandedEditors.has(id)) {
              expandedEditors.delete(id);
            } else {
              expandedEditors.add(id);
            }
            renderList();
          },
        }),
      );
    }
  }

  function loadOptions(): VectorLayerOptions {
    // Explicit 'table' when unchecked, so the toggle wins over a
    // control-level defaultIngestMode of 'stream'.
    return { ingestMode: streamInput.checked ? 'stream' : 'table' };
  }

  function loadFiles(files: FileList): void {
    for (const file of Array.from(files)) {
      void control.addData(file, loadOptions()).catch(() => {
        // Error already surfaced through the 'error' event.
      });
    }
  }

  // --- Event wiring ---------------------------------------------------------
  const onLoading: VectorControlEventHandler = (e) => setStatus(e.message ?? 'Loading...');
  const onError: VectorControlEventHandler = (e) =>
    setStatus(e.error?.message ?? 'Loading failed', true);
  const onLayerChange: VectorControlEventHandler = () => {
    setStatus(null);
    if (!styleEditInProgress) renderList();
  };

  control.on('loading', onLoading);
  control.on('error', onError);
  control.on('layeradded', onLayerChange);
  control.on('layerremoved', onLayerChange);
  control.on('layerupdated', onLayerChange);

  container.appendChild(dropZone);
  container.appendChild(fileInput);
  container.appendChild(urlRow);
  container.appendChild(streamRow);
  container.appendChild(status);
  container.appendChild(el('div', 'vector-control-divider'));
  container.appendChild(listTitle);
  container.appendChild(list);

  renderList();

  return () => {
    control.off('loading', onLoading);
    control.off('error', onError);
    control.off('layeradded', onLayerChange);
    control.off('layerremoved', onLayerChange);
    control.off('layerupdated', onLayerChange);
    container.innerHTML = '';
  };
}
