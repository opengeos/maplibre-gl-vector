import { describe, expect, it } from 'vitest';
import { KML_ICON_URL_PROPERTY, MAX_REMOTE_FILE_BYTES } from '../src/index';

describe('public constants', () => {
  it('exports the remote file size limit DuckDB-WASM can open', () => {
    expect(MAX_REMOTE_FILE_BYTES).toBe(2 ** 31 - 1);
  });

  it('exports the KML icon property the icon layer filters on', () => {
    expect(KML_ICON_URL_PROPERTY).toBe('__geolibre_kml_icon_url');
  });
});
