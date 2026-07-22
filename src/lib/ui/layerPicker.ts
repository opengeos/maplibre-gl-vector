import { el } from './dom';

/**
 * A modal checkbox picker for the layers of a multi-layer container
 * (a GeoPackage with several feature tables, a multi-layer GDAL source,
 * ...), so the user loads only the layers they want instead of every
 * layer in the file.
 */

/** Options for {@link openLayerPicker}. */
export interface LayerPickerOptions {
  /** Element the modal is appended to (normally the map container). */
  container: HTMLElement;
  /** Layer names offered, in the container's own order. */
  layers: string[];
  /** Display name of the container (file name or URL), shown in the prompt. */
  sourceName: string;
}

/** A picker that has been opened (or queued behind an earlier one). */
export interface LayerPickerHandle {
  /** Resolves with the chosen layer names; empty when the user cancelled. */
  selection: Promise<string[]>;
  /** Closes the picker as if the user cancelled (resolves with `[]`). */
  close(): void;
}

// One picker at a time per container: the panel starts a load per dropped
// file without awaiting, so two multi-layer files would otherwise stack two
// modals on top of each other. Each open waits for the previous one to
// settle, and the chain is keyed by container so separate maps stay
// independent.
const pickerQueues = new WeakMap<HTMLElement, Promise<unknown>>();

/**
 * Opens a modal layer picker over `container` and resolves with the layers
 * the user chose. Every layer starts selected, so confirming without changing
 * anything loads the whole container (the behavior before the picker existed).
 *
 * @param options - The container, the layer names, and the source name.
 * @returns A handle carrying the selection promise and a programmatic close.
 */
export function openLayerPicker(options: LayerPickerOptions): LayerPickerHandle {
  // Closing before the queued turn arrives must still cancel, so the state
  // lives here rather than inside the (not yet created) modal.
  let closed = false;
  let cancelOpenPicker: (() => void) | null = null;

  const show = (): Promise<string[]> =>
    closed
      ? Promise.resolve([])
      : renderLayerPicker(options, (cancel) => {
          cancelOpenPicker = cancel;
        });

  const previous = pickerQueues.get(options.container) ?? Promise.resolve();
  // `.then(show, show)`: a rejected predecessor must not strand this picker.
  const selection = previous.then(show, show);
  pickerQueues.set(options.container, selection);

  return {
    selection,
    close: () => {
      closed = true;
      cancelOpenPicker?.();
    },
  };
}

/**
 * Builds the modal, wires it up, and resolves once the user confirms or
 * cancels. `registerCancel` receives the cancel callback so the caller's
 * handle can close a picker that is already on screen.
 */
function renderLayerPicker(
  options: LayerPickerOptions,
  registerCancel: (cancel: () => void) => void,
): Promise<string[]> {
  const { container, layers, sourceName } = options;

  return new Promise<string[]>((resolve) => {
    const titleId = `vector-layer-picker-title-${Math.random().toString(36).slice(2, 10)}`;

    const overlay = el('div', 'vector-control-layer-picker');
    const dialog = el('div', 'vector-control-layer-picker-dialog', {
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': titleId,
    });

    const title = el('div', 'vector-control-layer-picker-title', { id: titleId });
    title.textContent = 'Choose layers to load';
    const subtitle = el('div', 'vector-control-layer-picker-subtitle');
    subtitle.textContent = `${sourceName} contains ${layers.length} layers.`;

    // "Select all" sits outside the scrolling list so it stays reachable for a
    // container with many layers.
    const selectAllRow = el('label', 'vector-control-layer-picker-all');
    const selectAll = el('input', 'vector-control-checkbox') as HTMLInputElement;
    selectAll.type = 'checkbox';
    selectAll.checked = true;
    const selectAllText = el('span');
    selectAllText.textContent = 'Select all';
    selectAllRow.appendChild(selectAll);
    selectAllRow.appendChild(selectAllText);

    const list = el('div', 'vector-control-layer-picker-list');
    const boxes: HTMLInputElement[] = [];
    for (const layer of layers) {
      const row = el('label', 'vector-control-layer-picker-item');
      const box = el('input', 'vector-control-checkbox') as HTMLInputElement;
      box.type = 'checkbox';
      box.checked = true;
      box.value = layer;
      const text = el('span', 'vector-control-layer-picker-name');
      // textContent, never innerHTML: a layer name comes from the file.
      text.textContent = layer;
      text.title = layer;
      row.appendChild(box);
      row.appendChild(text);
      list.appendChild(row);
      boxes.push(box);
    }

    const footer = el('div', 'vector-control-layer-picker-footer');
    const cancelButton = el('button', 'vector-control-button vector-control-button-secondary', {
      type: 'button',
    });
    cancelButton.textContent = 'Cancel';
    const loadButton = el('button', 'vector-control-button', { type: 'button' });
    footer.appendChild(cancelButton);
    footer.appendChild(loadButton);

    const chosen = (): string[] => boxes.filter((box) => box.checked).map((box) => box.value);

    const syncState = (): void => {
      const count = chosen().length;
      selectAll.checked = count === layers.length;
      selectAll.indeterminate = count > 0 && count < layers.length;
      loadButton.disabled = count === 0;
      loadButton.textContent = count === 1 ? 'Load 1 layer' : `Load ${count} layers`;
    };

    for (const box of boxes) box.addEventListener('change', syncState);
    selectAll.addEventListener('change', () => {
      for (const box of boxes) box.checked = selectAll.checked;
      syncState();
    });
    syncState();

    let settled = false;
    const finish = (result: string[]): void => {
      if (settled) return;
      settled = true;
      overlay.remove();
      resolve(result);
    };

    cancelButton.addEventListener('click', () => finish([]));
    loadButton.addEventListener('click', () => finish(chosen()));
    // Clicking the backdrop (not the dialog) cancels, like a native dialog.
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) finish([]);
    });
    // The overlay sits inside the map container, so let neither the map nor
    // the control's click-outside handler see clicks meant for the dialog.
    for (const type of ['mousedown', 'click', 'dblclick', 'wheel'] as const) {
      overlay.addEventListener(type, (event) => event.stopPropagation());
    }
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        finish([]);
      }
    });

    dialog.appendChild(title);
    dialog.appendChild(subtitle);
    dialog.appendChild(selectAllRow);
    dialog.appendChild(list);
    dialog.appendChild(footer);
    overlay.appendChild(dialog);
    container.appendChild(overlay);

    // Focus inside the dialog so Escape and Tab land on it rather than on the
    // page behind it.
    selectAll.focus();

    registerCancel(() => finish([]));
  });
}
