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
