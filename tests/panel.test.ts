import { describe, it, expect, vi } from 'vitest';
import { renderPanelUI, type PanelHost } from '../src/lib/ui/panel';

function createFakeHost(): PanelHost {
  return {
    addData: vi.fn(async () => {
      throw new Error('not under test');
    }),
    removeLayer: vi.fn(),
    getLayers: vi.fn(() => []),
    setLayerVisibility: vi.fn(),
    zoomToLayer: vi.fn(),
    setLayerStyle: vi.fn(),
    setLayerPicker: vi.fn(),
    setLayerBeforeId: vi.fn(),
    setRenderMode: vi.fn(async () => undefined),
    getMap: vi.fn(() => undefined),
    on: vi.fn(),
    off: vi.fn(),
  };
}

describe('renderPanelUI URL input', () => {
  it('uses the default placeholder when none is given', () => {
    const container = document.createElement('div');
    const dispose = renderPanelUI({ container, control: createFakeHost() });

    const input = container.querySelector<HTMLInputElement>('input[type=url]')!;
    expect(input.placeholder).toBe('https://example.com/data.parquet');
    expect(input.value).toBe('');
    dispose();
  });

  it('prefills the input with defaultUrl', () => {
    const container = document.createElement('div');
    const dispose = renderPanelUI({
      container,
      control: createFakeHost(),
      urlPlaceholder: 'https://example.com/sample.geojson',
      defaultUrl: 'https://example.com/countries.parquet',
    });

    const input = container.querySelector<HTMLInputElement>('input[type=url]')!;
    expect(input.placeholder).toBe('https://example.com/sample.geojson');
    expect(input.value).toBe('https://example.com/countries.parquet');
    expect(dispose).toBeTypeOf('function');
    dispose();
  });

  it('does not load defaultUrl without autoLoad', () => {
    const container = document.createElement('div');
    const host = createFakeHost();
    const dispose = renderPanelUI({
      container,
      control: host,
      defaultUrl: 'https://example.com/countries.parquet',
    });

    expect(host.addData).not.toHaveBeenCalled();
    dispose();
  });

  it('loads defaultUrl on mount with autoLoad and clears the input', async () => {
    const container = document.createElement('div');
    const host = createFakeHost();
    host.addData = vi.fn(async () => ({}) as never);
    const dispose = renderPanelUI({
      container,
      control: host,
      defaultUrl: 'https://example.com/countries.parquet',
      autoLoad: true,
    });

    expect(host.addData).toHaveBeenCalledExactlyOnceWith(
      'https://example.com/countries.parquet',
      { ingestMode: 'table' },
    );
    await vi.waitFor(() => {
      const input = container.querySelector<HTMLInputElement>('input[type=url]')!;
      expect(input.value).toBe('');
    });
    dispose();
  });

  it('is a no-op when autoLoad is set without defaultUrl', () => {
    const container = document.createElement('div');
    const host = createFakeHost();
    const dispose = renderPanelUI({ container, control: host, autoLoad: true });

    expect(host.addData).not.toHaveBeenCalled();
    dispose();
  });
});

describe('renderPanelUI sample data', () => {
  const trigger = (container: HTMLElement) =>
    container.querySelector<HTMLButtonElement>('.vector-control-sample-trigger')!;
  const menu = (container: HTMLElement) =>
    container.querySelector<HTMLDivElement>('.vector-control-sample-menu')!;
  const optionButtons = (container: HTMLElement) =>
    Array.from(container.querySelectorAll<HTMLButtonElement>('.vector-control-sample-option'));

  /** Open the dropdown and click the option at `index`. */
  function pickSample(container: HTMLElement, index: number): void {
    trigger(container).click();
    optionButtons(container)[index].click();
  }

  it('renders no sample row when no samples are given', () => {
    const container = document.createElement('div');
    const dispose = renderPanelUI({ container, control: createFakeHost() });

    expect(container.querySelector('.vector-control-sample-row')).toBeNull();
    dispose();
  });

  it('renders no sample row for an empty sample list', () => {
    const container = document.createElement('div');
    const dispose = renderPanelUI({ container, control: createFakeHost(), sampleData: [] });

    expect(container.querySelector('.vector-control-sample-row')).toBeNull();
    dispose();
  });

  it('renders a trigger plus one option per sample, menu closed, URL input empty', () => {
    const container = document.createElement('div');
    const dispose = renderPanelUI({
      container,
      control: createFakeHost(),
      sampleData: [
        { label: 'Countries', url: 'https://example.com/countries.parquet' },
        { label: 'Cities', url: 'https://example.com/cities.geojson' },
      ],
    });

    expect(trigger(container).querySelector('.vector-control-sample-trigger-label')!.textContent).toBe(
      'Load sample data...',
    );
    expect(menu(container).hidden).toBe(true);
    expect(trigger(container).getAttribute('aria-expanded')).toBe('false');
    expect(optionButtons(container).map((b) => b.textContent)).toEqual(['Countries', 'Cities']);
    expect(optionButtons(container)[0].title).toBe('https://example.com/countries.parquet');

    const input = container.querySelector<HTMLInputElement>('input[type=url]')!;
    expect(input.value).toBe('');
    dispose();
  });

  it('uses a custom placeholder when provided', () => {
    const container = document.createElement('div');
    const dispose = renderPanelUI({
      container,
      control: createFakeHost(),
      sampleDataLabel: 'Try a sample...',
      sampleData: [{ label: 'Countries', url: 'https://example.com/countries.parquet' }],
    });

    expect(trigger(container).querySelector('.vector-control-sample-trigger-label')!.textContent).toBe(
      'Try a sample...',
    );
    dispose();
  });

  it('opens the menu when the trigger is clicked', () => {
    const container = document.createElement('div');
    const dispose = renderPanelUI({
      container,
      control: createFakeHost(),
      sampleData: [{ label: 'Countries', url: 'https://example.com/countries.parquet' }],
    });

    trigger(container).click();
    expect(menu(container).hidden).toBe(false);
    expect(trigger(container).getAttribute('aria-expanded')).toBe('true');

    trigger(container).click();
    expect(menu(container).hidden).toBe(true);
    dispose();
  });

  it('fills the URL input, loads, and closes the menu when an option is picked', () => {
    const container = document.createElement('div');
    const host = createFakeHost();
    host.addData = vi.fn(async () => ({}) as never);
    const dispose = renderPanelUI({
      container,
      control: host,
      sampleData: [{ label: 'Countries', url: 'https://example.com/countries.parquet' }],
    });

    pickSample(container, 0);

    const input = container.querySelector<HTMLInputElement>('input[type=url]')!;
    expect(input.value).toBe('https://example.com/countries.parquet');
    expect(menu(container).hidden).toBe(true);
    expect(host.addData).toHaveBeenCalledExactlyOnceWith(
      'https://example.com/countries.parquet',
      { ingestMode: 'table' },
    );
    dispose();
  });

  it('closes the menu on an outside pointerdown', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const dispose = renderPanelUI({
      container,
      control: createFakeHost(),
      sampleData: [{ label: 'Countries', url: 'https://example.com/countries.parquet' }],
    });

    trigger(container).click();
    expect(menu(container).hidden).toBe(false);

    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(menu(container).hidden).toBe(true);

    dispose();
    container.remove();
  });

  it('passes a per-sample name and render mode through to addData', () => {
    const container = document.createElement('div');
    const host = createFakeHost();
    host.addData = vi.fn(async () => ({}) as never);
    const dispose = renderPanelUI({
      container,
      control: host,
      sampleData: [
        {
          label: 'Counties',
          url: 'https://example.com/counties.parquet',
          name: 'US counties',
          renderMode: 'tiles',
        },
      ],
    });

    pickSample(container, 0);

    expect(host.addData).toHaveBeenCalledExactlyOnceWith('https://example.com/counties.parquet', {
      ingestMode: 'table',
      name: 'US counties',
      renderMode: 'tiles',
    });
    dispose();
  });

  it('honours a per-sample ingestMode over the streaming toggle', () => {
    const container = document.createElement('div');
    const host = createFakeHost();
    host.addData = vi.fn(async () => ({}) as never);
    const dispose = renderPanelUI({
      container,
      control: host,
      sampleData: [
        { label: 'Countries', url: 'https://example.com/countries.parquet', ingestMode: 'stream' },
      ],
    });

    pickSample(container, 0);

    expect(host.addData).toHaveBeenCalledExactlyOnceWith(
      'https://example.com/countries.parquet',
      { ingestMode: 'stream' },
    );
    dispose();
  });
});

describe('renderPanelUI file input', () => {
  function selectFiles(container: HTMLElement, files: File[]): void {
    const input = container.querySelector<HTMLInputElement>('input[type=file]')!;
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: {
        length: files.length,
        item: (i: number) => files[i] ?? null,
        ...files,
        [Symbol.iterator]: function* () {
          yield* files;
        },
      },
    });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  it('loads a loose shapefile as one layer, passing the sidecars as companionFiles', () => {
    const container = document.createElement('div');
    const host = createFakeHost();
    host.addData = vi.fn(async () => ({}) as never);
    const dispose = renderPanelUI({ container, control: host });

    const shp = new File(['shp'], 'cities.shp');
    const shx = new File(['shx'], 'cities.shx');
    const dbf = new File(['dbf'], 'cities.dbf');
    selectFiles(container, [shp, shx, dbf]);

    // Only the .shp loads; the sidecars ride along as companionFiles instead of
    // failing as their own layers.
    expect(host.addData).toHaveBeenCalledTimes(1);
    const [source, options] = (host.addData as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(source).toBe(shp);
    expect(options.companionFiles).toEqual([shx, dbf]);

    dispose();
  });

  it('loads non-shapefile files individually without companionFiles', () => {
    const container = document.createElement('div');
    const host = createFakeHost();
    host.addData = vi.fn(async () => ({}) as never);
    const dispose = renderPanelUI({ container, control: host });

    const a = new File(['a'], 'a.geojson');
    const b = new File(['b'], 'b.parquet');
    selectFiles(container, [a, b]);

    expect(host.addData).toHaveBeenCalledTimes(2);
    for (const call of (host.addData as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[1].companionFiles).toBeUndefined();
    }

    dispose();
  });
});
