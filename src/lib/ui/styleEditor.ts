import type { VectorLayerInfo, VectorLayerStyle } from '../core/types';
import { el } from './dom';

/**
 * Callbacks for style editor interactions.
 */
export interface StyleEditorCallbacks {
  /** Called when a style value changes */
  onStyle: (patch: Partial<VectorLayerStyle>) => void;
  /** Called when the render mode select changes */
  onRenderMode: (mode: 'auto' | 'geojson' | 'tiles') => void;
}

function colorRow(
  label: string,
  value: string,
  onChange: (value: string) => void,
): HTMLElement {
  const row = el('label', 'vector-control-style-row');
  const text = el('span', 'vector-control-style-label');
  text.textContent = label;
  const input = el('input', 'vector-control-color') as HTMLInputElement;
  input.type = 'color';
  input.value = value;
  input.addEventListener('input', () => onChange(input.value));
  row.appendChild(text);
  row.appendChild(input);
  return row;
}

function numberRow(
  label: string,
  value: number,
  opts: { min: number; max: number; step: number },
  onChange: (value: number) => void,
): HTMLElement {
  const row = el('label', 'vector-control-style-row');
  const text = el('span', 'vector-control-style-label');
  text.textContent = label;
  const input = el('input', 'vector-control-range') as HTMLInputElement;
  input.type = 'range';
  input.min = String(opts.min);
  input.max = String(opts.max);
  input.step = String(opts.step);
  input.value = String(value);
  const display = el('span', 'vector-control-range-value');
  display.textContent = String(value);
  input.addEventListener('input', () => {
    display.textContent = input.value;
    onChange(Number(input.value));
  });
  row.appendChild(text);
  row.appendChild(input);
  row.appendChild(display);
  return row;
}

/**
 * Builds the per-layer style editor (colors, widths, opacity, and the
 * render mode selector).
 *
 * @param layer - The layer being edited
 * @param callbacks - Interaction callbacks
 * @returns The editor element
 */
export function createStyleEditor(
  layer: VectorLayerInfo,
  callbacks: StyleEditorCallbacks,
): HTMLElement {
  const editor = el('div', 'vector-control-style-editor');
  const { style, geometryType } = layer;
  const showFill = geometryType === 'polygon' || geometryType === 'mixed' || geometryType === 'unknown';
  const showLine = geometryType !== 'point';
  const showCircle = geometryType === 'point' || geometryType === 'mixed' || geometryType === 'unknown';

  if (showFill) {
    editor.appendChild(colorRow('Fill', style.fillColor, (fillColor) => callbacks.onStyle({ fillColor })));
    editor.appendChild(
      numberRow('Opacity', style.fillOpacity, { min: 0, max: 1, step: 0.05 }, (fillOpacity) =>
        callbacks.onStyle({ fillOpacity }),
      ),
    );
  }
  if (showLine) {
    editor.appendChild(colorRow('Line', style.lineColor, (lineColor) => callbacks.onStyle({ lineColor })));
    editor.appendChild(
      numberRow('Width', style.lineWidth, { min: 0, max: 10, step: 0.5 }, (lineWidth) =>
        callbacks.onStyle({ lineWidth }),
      ),
    );
  }
  if (showCircle) {
    editor.appendChild(
      colorRow('Circle', style.circleColor, (circleColor) => callbacks.onStyle({ circleColor })),
    );
    editor.appendChild(
      numberRow('Radius', style.circleRadius, { min: 1, max: 20, step: 1 }, (circleRadius) =>
        callbacks.onStyle({ circleRadius }),
      ),
    );
  }

  // Render mode selector
  const modeRow = el('label', 'vector-control-style-row');
  const modeLabel = el('span', 'vector-control-style-label');
  modeLabel.textContent = 'Mode';
  const select = el('select', 'vector-control-select') as HTMLSelectElement;
  for (const mode of ['auto', 'geojson', 'tiles'] as const) {
    const option = el('option') as HTMLOptionElement;
    option.value = mode;
    option.textContent = mode === 'geojson' ? 'GeoJSON' : mode === 'tiles' ? 'Tiles' : 'Auto';
    if (mode === layer.renderMode) option.selected = true;
    select.appendChild(option);
  }
  select.addEventListener('change', () => {
    callbacks.onRenderMode(select.value as 'auto' | 'geojson' | 'tiles');
  });
  modeRow.appendChild(modeLabel);
  modeRow.appendChild(select);
  editor.appendChild(modeRow);

  return editor;
}
