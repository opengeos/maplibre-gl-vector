import type { Map as MapLibreMap } from 'maplibre-gl';
import type {
  RenderMode,
  VectorControlEvent,
  VectorControlEventHandler,
  VectorDataSource,
  VectorLayerInfo,
  VectorLayerOptions,
  VectorLayerStyle,
  VectorSampleDataset,
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
  /** Placeholder text for the URL input */
  urlPlaceholder?: string;
  /** Initial value of the URL input (cleared after a successful load) */
  defaultUrl?: string;
  /** Load defaultUrl immediately, as if the user had pressed Load */
  autoLoad?: boolean;
  /** One-click sample datasets shown below the URL input (row hidden when empty) */
  sampleData?: VectorSampleDataset[];
  /** Label shown before the sample links (defaults to 'Load sample data:') */
  sampleDataLabel?: string;
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
  urlInput.placeholder = options.urlPlaceholder ?? 'https://example.com/data.parquet';
  if (options.defaultUrl) urlInput.value = options.defaultUrl;
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

  // --- Sample data links ---------------------------------------------------
  // Optional one-click examples, decoupled from the URL input so the input
  // stays empty for the user's own links. Hidden entirely when no host
  // supplies samples.
  const samples = options.sampleData ?? [];
  const sampleRow = el('div', 'vector-control-sample-row');
  if (samples.length > 0) {
    const sampleLabel = el('span', 'vector-control-sample-label');
    sampleLabel.textContent = options.sampleDataLabel ?? 'Load sample data:';
    sampleRow.appendChild(sampleLabel);
    for (const sample of samples) {
      const link = el('button', 'vector-control-sample-link', { type: 'button' });
      link.textContent = sample.label;
      link.title = sample.url;
      link.addEventListener('click', () => {
        // A per-sample ingestMode wins; otherwise fall through to the
        // streaming toggle so the sample behaves like a manual load.
        const sampleOptions: VectorLayerOptions = sample.ingestMode
          ? { ingestMode: sample.ingestMode }
          : loadOptions();
        if (sample.name) sampleOptions.name = sample.name;
        if (sample.renderMode) sampleOptions.renderMode = sample.renderMode;
        void control.addData(sample.url, sampleOptions).catch(() => {
          // Error already surfaced through the 'error' event.
        });
      });
      sampleRow.appendChild(link);
    }
  }

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
  if (samples.length > 0) container.appendChild(sampleRow);
  container.appendChild(streamRow);
  container.appendChild(status);
  container.appendChild(el('div', 'vector-control-divider'));
  container.appendChild(listTitle);
  container.appendChild(list);

  renderList();

  // Kick off the initial load through the same path as the Load button,
  // so progress/errors surface in the status line and the input clears
  // on success.
  if (options.autoLoad && urlInput.value) loadUrl();

  return () => {
    control.off('loading', onLoading);
    control.off('error', onError);
    control.off('layeradded', onLayerChange);
    control.off('layerremoved', onLayerChange);
    control.off('layerupdated', onLayerChange);
    container.innerHTML = '';
  };
}
