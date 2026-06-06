import type { VectorLayerInfo, VectorLayerStyle } from '../core/types';
import { el, svgIcon, ICONS } from './dom';
import { createStyleEditor } from './styleEditor';

/**
 * Callbacks for layer list item interactions.
 */
export interface LayerItemCallbacks {
  onToggleVisibility: (id: string, visible: boolean) => void;
  onZoom: (id: string) => void;
  onRemove: (id: string) => void;
  onStyle: (id: string, patch: Partial<VectorLayerStyle>) => void;
  onRenderMode: (id: string, mode: 'auto' | 'geojson' | 'tiles') => void;
  /** Toggles the expanded state of the style editor */
  onToggleEditor: (id: string) => void;
}

function iconButton(title: string, paths: string, onClick: () => void): HTMLButtonElement {
  const button = el('button', 'vector-control-icon-btn', { type: 'button', title });
  button.setAttribute('aria-label', title);
  button.appendChild(svgIcon(paths));
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return button;
}

function formatCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

/**
 * Builds a single row in the layer list, with visibility, zoom, style,
 * and remove actions plus an optional expanded style editor.
 *
 * @param layer - The layer to render
 * @param expanded - Whether the style editor is expanded
 * @param callbacks - Interaction callbacks
 * @returns The list item element
 */
export function createLayerListItem(
  layer: VectorLayerInfo,
  expanded: boolean,
  callbacks: LayerItemCallbacks,
): HTMLElement {
  const item = el('div', 'vector-control-layer-item');
  item.dataset.layerId = layer.id;

  const row = el('div', 'vector-control-layer-row');

  // Visibility toggle
  row.appendChild(
    iconButton(
      layer.visible ? 'Hide layer' : 'Show layer',
      layer.visible ? ICONS.eye : ICONS.eyeOff,
      () => callbacks.onToggleVisibility(layer.id, !layer.visible),
    ),
  );

  // Name and meta
  const nameWrap = el('div', 'vector-control-layer-name-wrap');
  const name = el('div', 'vector-control-layer-name', { title: layer.name });
  name.textContent = layer.name;
  const meta = el('div', 'vector-control-layer-meta');
  const parts: string[] = [layer.format];
  if (layer.featureCount !== undefined) parts.push(`${formatCount(layer.featureCount)} ft`);
  parts.push(layer.renderMode === 'tiles' ? 'tiles' : 'geojson');
  meta.textContent = parts.join(' · ');
  nameWrap.appendChild(name);
  nameWrap.appendChild(meta);
  nameWrap.addEventListener('click', () => callbacks.onToggleEditor(layer.id));
  row.appendChild(nameWrap);

  // Actions
  const actions = el('div', 'vector-control-layer-actions');
  actions.appendChild(iconButton('Zoom to layer', ICONS.zoom, () => callbacks.onZoom(layer.id)));
  actions.appendChild(
    iconButton('Layer style', ICONS.sliders, () => callbacks.onToggleEditor(layer.id)),
  );
  actions.appendChild(iconButton('Remove layer', ICONS.trash, () => callbacks.onRemove(layer.id)));
  row.appendChild(actions);

  item.appendChild(row);

  if (expanded) {
    item.appendChild(
      createStyleEditor(layer, {
        onStyle: (patch) => callbacks.onStyle(layer.id, patch),
        onRenderMode: (mode) => callbacks.onRenderMode(layer.id, mode),
      }),
    );
  }

  return item;
}
