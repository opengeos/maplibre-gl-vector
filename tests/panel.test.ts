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
    dispose();
  });
});
