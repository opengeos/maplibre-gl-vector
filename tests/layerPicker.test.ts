import { describe, it, expect, afterEach } from 'vitest';
import { openLayerPicker } from '../src/lib/ui/layerPicker';

function createContainer(): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  return container;
}

function dialogIn(container: HTMLElement): HTMLElement | null {
  return container.querySelector('.vector-control-layer-picker');
}

function layerBoxes(container: HTMLElement): HTMLInputElement[] {
  return Array.from(
    container.querySelectorAll<HTMLInputElement>('.vector-control-layer-picker-item input'),
  );
}

function buttonLabelled(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.startsWith(text),
  );
  if (!button) throw new Error(`No button starting with "${text}"`);
  return button as HTMLButtonElement;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('openLayerPicker', () => {
  it('preselects every layer and resolves with the confirmed selection', async () => {
    const container = createContainer();
    const picker = openLayerPicker({
      container,
      layers: ['roads', 'buildings', 'parks'],
      sourceName: 'city.gpkg',
    });
    await Promise.resolve();

    const boxes = layerBoxes(container);
    expect(boxes.map((box) => box.value)).toEqual(['roads', 'buildings', 'parks']);
    expect(boxes.every((box) => box.checked)).toBe(true);
    expect(buttonLabelled(container, 'Load').textContent).toBe('Load 3 layers');

    boxes[1].checked = false;
    boxes[1].dispatchEvent(new Event('change'));
    expect(buttonLabelled(container, 'Load').textContent).toBe('Load 2 layers');

    buttonLabelled(container, 'Load').click();
    await expect(picker.selection).resolves.toEqual(['roads', 'parks']);
    expect(dialogIn(container)).toBeNull();
  });

  it('resolves empty when the user cancels', async () => {
    const container = createContainer();
    const picker = openLayerPicker({
      container,
      layers: ['roads', 'buildings'],
      sourceName: 'city.gpkg',
    });
    await Promise.resolve();

    buttonLabelled(container, 'Cancel').click();
    await expect(picker.selection).resolves.toEqual([]);
    expect(dialogIn(container)).toBeNull();
  });

  it('cancels on Escape', async () => {
    const container = createContainer();
    const picker = openLayerPicker({
      container,
      layers: ['roads', 'buildings'],
      sourceName: 'city.gpkg',
    });
    await Promise.resolve();

    dialogIn(container)!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await expect(picker.selection).resolves.toEqual([]);
  });

  it('disables Load when nothing is selected, via the select-all toggle', async () => {
    const container = createContainer();
    openLayerPicker({ container, layers: ['roads', 'buildings'], sourceName: 'city.gpkg' });
    await Promise.resolve();

    const selectAll = container.querySelector<HTMLInputElement>(
      '.vector-control-layer-picker-all input',
    )!;
    selectAll.checked = false;
    selectAll.dispatchEvent(new Event('change'));

    expect(layerBoxes(container).some((box) => box.checked)).toBe(false);
    expect(buttonLabelled(container, 'Load').disabled).toBe(true);
  });

  it('marks select-all indeterminate on a partial selection', async () => {
    const container = createContainer();
    openLayerPicker({ container, layers: ['roads', 'buildings'], sourceName: 'city.gpkg' });
    await Promise.resolve();

    const boxes = layerBoxes(container);
    boxes[0].checked = false;
    boxes[0].dispatchEvent(new Event('change'));

    const selectAll = container.querySelector<HTMLInputElement>(
      '.vector-control-layer-picker-all input',
    )!;
    expect(selectAll.checked).toBe(false);
    expect(selectAll.indeterminate).toBe(true);
  });

  it('shows one picker at a time, queueing the next', async () => {
    const container = createContainer();
    const first = openLayerPicker({ container, layers: ['a', 'b'], sourceName: 'one.gpkg' });
    const second = openLayerPicker({ container, layers: ['c', 'd'], sourceName: 'two.gpkg' });
    await Promise.resolve();

    expect(container.querySelectorAll('.vector-control-layer-picker')).toHaveLength(1);
    expect(layerBoxes(container).map((box) => box.value)).toEqual(['a', 'b']);

    buttonLabelled(container, 'Cancel').click();
    await first.selection;
    await Promise.resolve();

    expect(layerBoxes(container).map((box) => box.value)).toEqual(['c', 'd']);
    buttonLabelled(container, 'Load').click();
    await expect(second.selection).resolves.toEqual(['c', 'd']);
  });

  it('close() cancels a picker that is still queued', async () => {
    const container = createContainer();
    const first = openLayerPicker({ container, layers: ['a', 'b'], sourceName: 'one.gpkg' });
    const second = openLayerPicker({ container, layers: ['c', 'd'], sourceName: 'two.gpkg' });
    second.close();
    await Promise.resolve();

    buttonLabelled(container, 'Cancel').click();
    await first.selection;

    await expect(second.selection).resolves.toEqual([]);
    expect(dialogIn(container)).toBeNull();
  });

  it('close() dismisses a picker that is already on screen', async () => {
    const container = createContainer();
    const picker = openLayerPicker({ container, layers: ['a', 'b'], sourceName: 'one.gpkg' });
    await Promise.resolve();
    expect(dialogIn(container)).not.toBeNull();

    picker.close();
    await expect(picker.selection).resolves.toEqual([]);
    expect(dialogIn(container)).toBeNull();
  });

  it('renders layer names as text, never as markup', async () => {
    const container = createContainer();
    openLayerPicker({
      container,
      layers: ['<img src=x onerror=alert(1)>', 'safe'],
      sourceName: 'evil.gpkg',
    });
    await Promise.resolve();

    expect(container.querySelector('img')).toBeNull();
    const name = container.querySelector('.vector-control-layer-picker-name')!;
    expect(name.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});
