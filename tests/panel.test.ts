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

  it('renders a labelled link per sample and keeps the URL input empty', () => {
    const container = document.createElement('div');
    const dispose = renderPanelUI({
      container,
      control: createFakeHost(),
      sampleData: [
        { label: 'Countries', url: 'https://example.com/countries.parquet' },
        { label: 'Cities', url: 'https://example.com/cities.geojson' },
      ],
    });

    const row = container.querySelector('.vector-control-sample-row')!;
    expect(row).not.toBeNull();
    expect(row.querySelector('.vector-control-sample-label')!.textContent).toBe(
      'Load sample data:',
    );
    const links = row.querySelectorAll<HTMLButtonElement>('.vector-control-sample-link');
    expect(Array.from(links).map((link) => link.textContent)).toEqual(['Countries', 'Cities']);
    expect(links[0].title).toBe('https://example.com/countries.parquet');

    const input = container.querySelector<HTMLInputElement>('input[type=url]')!;
    expect(input.value).toBe('');
    dispose();
  });

  it('uses a custom sample label when provided', () => {
    const container = document.createElement('div');
    const dispose = renderPanelUI({
      container,
      control: createFakeHost(),
      sampleDataLabel: 'Try a sample:',
      sampleData: [{ label: 'Countries', url: 'https://example.com/countries.parquet' }],
    });

    expect(container.querySelector('.vector-control-sample-label')!.textContent).toBe(
      'Try a sample:',
    );
    dispose();
  });

  it('loads the sample URL on click, honouring the streaming toggle by default', () => {
    const container = document.createElement('div');
    const host = createFakeHost();
    host.addData = vi.fn(async () => ({}) as never);
    const dispose = renderPanelUI({
      container,
      control: host,
      sampleData: [{ label: 'Countries', url: 'https://example.com/countries.parquet' }],
    });

    container.querySelector<HTMLButtonElement>('.vector-control-sample-link')!.click();

    expect(host.addData).toHaveBeenCalledExactlyOnceWith(
      'https://example.com/countries.parquet',
      { ingestMode: 'table' },
    );
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

    container.querySelector<HTMLButtonElement>('.vector-control-sample-link')!.click();

    expect(host.addData).toHaveBeenCalledExactlyOnceWith(
      'https://example.com/countries.parquet',
      { ingestMode: 'stream' },
    );
    dispose();
  });
});
