import type { Map as MapLibreMap } from 'maplibre-gl';
import type {
  RenderMode,
  VectorControlEvent,
  VectorControlEventHandler,
  VectorDataSource,
  VectorFileOpener,
  VectorFileSelection,
  VectorLayerInfo,
  VectorLayerOptions,
  VectorLayerStyle,
  VectorSampleDataset,
} from '../core/types';
import { el, svgIcon, ICONS } from './dom';
import { createLayerListItem } from './layerListItem';
import { groupShapefileComponents } from '../formats/shapefile';

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
  /**
   * Host-supplied file picker. When set, clicking the drop zone calls this
   * instead of the native file input, and each returned selection is loaded
   * with its `sourcePath` recorded on the layer (see
   * {@link VectorControlOptions.fileOpener}).
   */
  fileOpener?: VectorFileOpener;
}

/**
 * Renders the vector control panel UI (file/URL loading, status line,
 * and the layer list) and wires it to the control.
 *
 * @param options - Panel options
 * @returns A dispose function that unsubscribes event handlers
 */
export function renderPanelUI(options: PanelUIOptions): () => void {
  const { container, control, fileOpener } = options;
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

  // A host can replace the native browse with its own picker (e.g. a desktop
  // dialog that yields real filesystem paths). Drag-and-drop still uses the
  // browser's dropped files, which carry no path.
  dropZone.addEventListener('click', () => {
    if (fileOpener) {
      void openViaHost();
    } else {
      fileInput.click();
    }
  });
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

  // --- Sample data dropdown ------------------------------------------------
  // A custom (not native <select>) dropdown so the menu is fully themeable
  // in dark mode -- the native option popup keeps a low-contrast system
  // highlight. Decoupled from the URL input so it stays empty for the
  // user's own links; picking one fills the input and loads it. Hidden
  // entirely when no host supplies samples.
  const samples = options.sampleData ?? [];
  const sampleRow = el('div', 'vector-control-sample-row');
  let onSampleDocPointerDown: ((event: MouseEvent) => void) | null = null;
  if (samples.length > 0) {
    const trigger = el('button', 'vector-control-sample-trigger', {
      type: 'button',
      'aria-haspopup': 'listbox',
      'aria-expanded': 'false',
    });
    const triggerLabel = el('span', 'vector-control-sample-trigger-label');
    triggerLabel.textContent = options.sampleDataLabel ?? 'Load sample data...';
    trigger.appendChild(triggerLabel);
    trigger.appendChild(svgIcon(ICONS.chevronDown, 14));

    const menu = el('div', 'vector-control-sample-menu', { role: 'listbox' });
    menu.hidden = true;

    let menuOpen = false;
    const setMenuOpen = (open: boolean): void => {
      menuOpen = open;
      menu.hidden = !open;
      trigger.setAttribute('aria-expanded', String(open));
      trigger.classList.toggle('open', open);
      if (open) (menu.firstElementChild as HTMLElement | null)?.focus();
    };

    for (const sample of samples) {
      const option = el('button', 'vector-control-sample-option', {
        type: 'button',
        role: 'option',
        title: sample.url,
      });
      option.textContent = sample.label;
      option.addEventListener('click', () => {
        setMenuOpen(false);
        trigger.focus();
        // Show the user which URL is loading, then load it.
        urlInput.value = sample.url;
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
      menu.appendChild(option);
    }

    trigger.addEventListener('click', () => setMenuOpen(!menuOpen));
    sampleRow.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Escape' && menuOpen) {
        setMenuOpen(false);
        trigger.focus();
      }
    });

    // Close when clicking anywhere outside the dropdown.
    onSampleDocPointerDown = (event: MouseEvent) => {
      if (!sampleRow.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onSampleDocPointerDown);

    sampleRow.appendChild(trigger);
    sampleRow.appendChild(menu);
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
      syncScrollbarPadding();
      return;
    }
    status.style.display = 'block';
    status.textContent = message;
    status.classList.toggle('error', isError);
    syncScrollbarPadding();
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
      syncScrollbarPadding();
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
    syncScrollbarPadding();
  }

  // The panel's scrollbar is an overlay in some engines, so it paints over
  // the right edge of the inputs/buttons when the content overflows.
  // Reserve room for it only while overflowing, keeping the left and right
  // margins symmetric when there is no scrollbar.
  function syncScrollbarPadding(): void {
    container.classList.toggle(
      'vector-control-has-scrollbar',
      container.scrollHeight > container.clientHeight,
    );
  }

  function loadOptions(): VectorLayerOptions {
    // Explicit 'table' when unchecked, so the toggle wins over a
    // control-level defaultIngestMode of 'stream'.
    return { ingestMode: streamInput.checked ? 'stream' : 'table' };
  }

  function loadFiles(files: FileList): void {
    // Group loose shapefile components selected together so a `.shp` loads with
    // its `.shx`/`.dbf`/`.prj`/... siblings as one layer, instead of the `.shp`
    // failing for missing siblings and each sidecar loading as its own layer.
    for (const { file, companions } of groupShapefileComponents(Array.from(files))) {
      const options =
        companions.length > 0
          ? { ...loadOptions(), companionFiles: companions }
          : loadOptions();
      void control.addData(file, options).catch(() => {
        // Error already surfaced through the 'error' event.
      });
    }
  }

  // Runs the host-supplied picker (when set) and loads its selections, carrying
  // each file's sourcePath through to addData so a desktop host can persist and
  // re-read it. Mirrors loadFiles' shapefile grouping; a returned empty list (or
  // a cancelled picker) loads nothing.
  async function openViaHost(): Promise<void> {
    let selections: VectorFileSelection[] | null | undefined;
    try {
      selections = await fileOpener?.();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not open files', true);
      return;
    }
    if (!selections || selections.length === 0) return;
    loadSelections(selections);
  }

  function loadSelections(selections: VectorFileSelection[]): void {
    // Only File instances can be regrouped by name for loose shapefiles; a raw
    // Blob has no name, so it loads on its own.
    const files = selections.map((selection) => selection.file);
    const pathByFile = new Map<File | Blob, string | undefined>(
      selections.map((selection) => [selection.file, selection.sourcePath]),
    );
    const nameByFile = new Map<File | Blob, string | undefined>(
      selections.map((selection) => [selection.file, selection.name]),
    );
    const fileEntries = files.filter((file): file is File => file instanceof File);
    const blobEntries = files.filter((file) => !(file instanceof File));

    for (const { file, companions } of groupShapefileComponents(fileEntries)) {
      const options: VectorLayerOptions = {
        ...loadOptions(),
        ...(companions.length > 0 ? { companionFiles: companions } : {}),
        ...(pathByFile.get(file) ? { sourcePath: pathByFile.get(file) } : {}),
        ...(nameByFile.get(file) ? { name: nameByFile.get(file) } : {}),
      };
      void control.addData(file, options).catch(() => {
        // Error already surfaced through the 'error' event.
      });
    }
    for (const blob of blobEntries) {
      const options: VectorLayerOptions = {
        ...loadOptions(),
        ...(pathByFile.get(blob) ? { sourcePath: pathByFile.get(blob) } : {}),
        ...(nameByFile.get(blob) ? { name: nameByFile.get(blob) } : {}),
      };
      void control.addData(blob, options).catch(() => {
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

  // Resizing the panel changes the content's own height (so the overflow
  // state can flip) without firing a layer event; a ResizeObserver keeps
  // the scrollbar padding in sync with those size changes.
  const scrollObserver =
    typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => syncScrollbarPadding())
      : null;
  scrollObserver?.observe(container);

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
    scrollObserver?.disconnect();
    if (onSampleDocPointerDown) {
      document.removeEventListener('pointerdown', onSampleDocPointerDown);
    }
    container.innerHTML = '';
  };
}
